/**
 * On-chain event reader — fetches vault and governor events via viem getLogs.
 *
 * Uses HTTP RPC (no WebSocket needed). Block ranges are capped at 10,000
 * per call to avoid RPC timeouts (~83 minutes on Base at 2 blocks/sec).
 */

import type { Address, Log } from "viem";
import { parseAbiItem } from "viem";
import { getPublicClient } from "./client.js";
import { getProposal, PROPOSAL_STATES } from "./governor.js";
import { resolveMetadataSummary } from "./ipfs.js";

const MAX_BLOCK_RANGE = 10_000n;

// ── Event signatures (parseAbiItem format for getLogs) ──

const VAULT_EVENTS = [
  parseAbiItem("event AgentRegistered(uint256 indexed agentId, address indexed agentAddress)"),
  parseAbiItem("event AgentRemoved(address indexed agentAddress)"),
  parseAbiItem("event DepositorApproved(address indexed depositor)"),
  parseAbiItem("event DepositorRemoved(address indexed depositor)"),
  parseAbiItem("event RedemptionsLockedEvent()"),
  parseAbiItem("event RedemptionsUnlockedEvent()"),
] as const;

const GOVERNOR_EVENTS = [
  parseAbiItem("event ProposalCreated(uint256 indexed proposalId, address indexed proposer, address indexed vault, uint256 performanceFeeBps, uint256 strategyDuration, uint256 executeCallCount, uint256 settlementCallCount, string metadataURI)"),
  parseAbiItem("event VoteCast(uint256 indexed proposalId, address indexed voter, uint8 support, uint256 weight)"),
  parseAbiItem("event ProposalExecuted(uint256 indexed proposalId, address indexed vault, uint256 capitalSnapshot)"),
  parseAbiItem("event ProposalSettled(uint256 indexed proposalId, address indexed vault, int256 pnl, uint256 performanceFee, uint256 duration)"),
  parseAbiItem("event ProposalCancelled(uint256 indexed proposalId, address indexed cancelledBy)"),
] as const;

/** Normalized event returned by the session check. */
export interface ChainEvent {
  source: "chain";
  type: string;
  block: number;
  tx: string;
  args: Record<string, string>;
}

function logToChainEvent(log: Log, eventName: string): ChainEvent {
  const args: Record<string, string> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const decoded = (log as any).args;
  if (decoded) {
    for (const [key, value] of Object.entries(decoded)) {
      args[key] = String(value);
    }
  }

  return {
    source: "chain",
    type: eventName,
    block: Number(log.blockNumber),
    tx: log.transactionHash || "",
    args,
  };
}

/**
 * Fetch events in chunks to stay within RPC limits.
 * Returns all logs from `fromBlock` to `toBlock` inclusive.
 */
async function getLogsChunked(params: {
  address: Address;
  events: readonly ReturnType<typeof parseAbiItem>[];
  fromBlock: bigint;
  toBlock: bigint;
}): Promise<Log[]> {
  const client = getPublicClient();
  const { address, events, fromBlock, toBlock } = params;

  const allLogs: Log[] = [];
  let cursor = fromBlock;

  while (cursor <= toBlock) {
    const end =
      cursor + MAX_BLOCK_RANGE - 1n > toBlock
        ? toBlock
        : cursor + MAX_BLOCK_RANGE - 1n;

    const logs = await client.getLogs({
      address,
      events: events as never,
      fromBlock: cursor,
      toBlock: end,
    });

    allLogs.push(...logs);
    cursor = end + 1n;
  }

  return allLogs;
}

/** Fetch vault events (AgentRegistered, Ragequit, etc.) */
export async function getVaultEvents(
  vaultAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ChainEvent[]> {
  const logs = await getLogsChunked({
    address: vaultAddress,
    events: VAULT_EVENTS,
    fromBlock,
    toBlock,
  });

  return logs.map((log) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eventName = (log as any).eventName || "UnknownVaultEvent";
    return logToChainEvent(log, eventName);
  });
}

/** Fetch governor events filtered to a specific vault. */
export async function getGovernorEvents(
  governorAddress: Address,
  vaultAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ChainEvent[]> {
  if (governorAddress === "0x0000000000000000000000000000000000000000") {
    return []; // Governor not deployed yet
  }

  const logs = await getLogsChunked({
    address: governorAddress,
    events: GOVERNOR_EVENTS,
    fromBlock,
    toBlock,
  });

  // Filter governor events to only those involving our vault
  return logs
    .filter((log) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const args = (log as any).args;
      if (!args) return true;
      // ProposalCreated, ProposalExecuted, ProposalSettled have `vault` in args
      if (args.vault) {
        return (args.vault as string).toLowerCase() === vaultAddress.toLowerCase();
      }
      // VoteCast, ProposalCancelled don't have vault — include them
      // (agents care about all votes/cancellations on their governor)
      return true;
    })
    .map((log) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const eventName = (log as any).eventName || "UnknownGovernorEvent";
      return logToChainEvent(log, eventName);
    });
}

/** Get current block number from the RPC. */
export async function getCurrentBlock(): Promise<bigint> {
  const client = getPublicClient();
  return client.getBlockNumber();
}

// ── Proposal event enrichment ──

const PROPOSAL_EVENT_TYPES = new Set([
  "ProposalCreated",
  "VoteCast",
  "ProposalExecuted",
  "ProposalSettled",
  "ProposalCancelled",
]);

/**
 * Enrich proposal-related events with IPFS metadata (name, description)
 * and current on-chain state. Best-effort — events are returned un-enriched
 * if RPC or IPFS calls fail.
 *
 * An optional metadataCache avoids redundant IPFS fetches across poll cycles
 * in streaming mode (proposal metadata is immutable once pinned).
 */
export async function enrichProposalEvents(
  events: ChainEvent[],
  metadataCache?: Map<string, { name: string; description: string }>,
): Promise<ChainEvent[]> {
  const cache = metadataCache ?? new Map<string, { name: string; description: string }>();

  const proposalEvents = events.filter((e) => PROPOSAL_EVENT_TYPES.has(e.type));
  if (proposalEvents.length === 0) return events;

  // Collect unique proposalIds and their metadata sources
  const idsNeedingLookup = new Set<string>();
  const createdURIs = new Map<string, string>(); // proposalId → metadataURI from event args

  for (const event of proposalEvents) {
    const pid = event.args.proposalId;
    if (!pid) continue;

    if (event.type === "ProposalCreated" && event.args.metadataURI) {
      createdURIs.set(pid, event.args.metadataURI);
    } else if (!cache.has(pid)) {
      idsNeedingLookup.add(pid);
    }
  }

  // Fetch on-chain proposal data for non-Created events (parallel, deduplicated)
  const proposalData = new Map<string, { metadataURI: string; state: number }>();

  await Promise.all(
    Array.from(idsNeedingLookup).map(async (pid) => {
      try {
        const p = await getProposal(BigInt(pid));
        proposalData.set(pid, { metadataURI: p.metadataURI, state: p.state });
      } catch {
        // RPC failure — skip enrichment for this proposalId
      }
    }),
  );

  // Resolve IPFS metadata (parallel, deduplicated, uses cache)
  const allURIs = new Map<string, string>();
  for (const [pid, uri] of createdURIs) allURIs.set(pid, uri);
  for (const [pid, data] of proposalData) {
    if (!allURIs.has(pid)) allURIs.set(pid, data.metadataURI);
  }

  await Promise.all(
    Array.from(allURIs.entries()).map(async ([pid, uri]) => {
      if (cache.has(pid) || !uri) return;
      const summary = await resolveMetadataSummary(uri);
      if (summary) cache.set(pid, summary);
    }),
  );

  // Inject enrichment fields into event args
  return events.map((event) => {
    if (!PROPOSAL_EVENT_TYPES.has(event.type)) return event;
    const pid = event.args.proposalId;
    if (!pid) return event;

    const meta = cache.get(pid);
    const pData = proposalData.get(pid);
    const enrichedArgs = { ...event.args };

    if (meta) {
      enrichedArgs.proposalName = meta.name;
      enrichedArgs.proposalDescription = meta.description;
    }

    if (event.type === "ProposalCreated") {
      enrichedArgs.proposalState = "Pending";
    } else if (pData) {
      enrichedArgs.proposalState = PROPOSAL_STATES[pData.state] || "Unknown";
    }

    return { ...event, args: enrichedArgs };
  });
}
