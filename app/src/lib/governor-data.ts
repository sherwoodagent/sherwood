/**
 * Server-side data fetching for governor / proposals.
 *
 * Reads governor address from the vault, then batch-reads all proposals
 * targeting that vault via multicall.
 */

import { type Address } from "viem";
import {
  getPublicClient,
  SYNDICATE_VAULT_ABI,
  SYNDICATE_GOVERNOR_ABI,
  formatUSDC,
} from "./contracts";

// ── Types ──────────────────────────────────────────────────

export enum ProposalState {
  Draft = 0,
  Pending = 1,
  Approved = 2,
  Rejected = 3,
  Expired = 4,
  Executed = 5,
  Settled = 6,
  Cancelled = 7,
}

export const PROPOSAL_STATE_LABELS: Record<ProposalState, string> = {
  [ProposalState.Draft]: "Draft",
  [ProposalState.Pending]: "Pending",
  [ProposalState.Approved]: "Approved",
  [ProposalState.Rejected]: "Rejected",
  [ProposalState.Expired]: "Expired",
  [ProposalState.Executed]: "Executed",
  [ProposalState.Settled]: "Settled",
  [ProposalState.Cancelled]: "Cancelled",
};

export interface ProposalMetadata {
  title: string;
  description: string;
}

export interface ProposalData {
  id: bigint;
  proposer: Address;
  vault: Address;
  metadataURI: string;
  performanceFeeBps: bigint;
  splitIndex: bigint;
  strategyDuration: bigint;
  votesFor: bigint;
  votesAgainst: bigint;
  votesAbstain?: bigint;
  snapshotTimestamp: bigint;
  voteEnd: bigint;
  executeBy: bigint;
  executedAt: bigint;
  state: ProposalState;
  // Enriched fields
  computedState: ProposalState;
  capitalSnapshot: bigint;
  metadata: ProposalMetadata | null;
  pnl?: bigint; // P&L in deposit asset terms (positive = profit, negative = loss)
}

export interface GovernorParams {
  votingPeriod: bigint;
  executionWindow: bigint;
  quorumBps: bigint;
  maxPerformanceFeeBps: bigint;
  cooldownPeriod: bigint;
  collaborationWindow: bigint;
  maxCoProposers: bigint;
  minStrategyDuration: bigint;
  maxStrategyDuration: bigint;
}

export interface GovernorData {
  governorAddress: Address;
  proposals: ProposalData[];
  activeProposalId: bigint;
  cooldownEnd: bigint;
  params: GovernorParams;
}

// ── IPFS Metadata ──────────────────────────────────────────

const PINATA_GATEWAY =
  process.env.PINATA_GATEWAY || "https://sherwood.mypinata.cloud";

async function fetchProposalMetadata(
  uri: string,
): Promise<ProposalMetadata | null> {
  try {
    let url: string;
    if (uri.startsWith("ipfs://")) {
      url = `${PINATA_GATEWAY}/ipfs/${uri.slice(7)}`;
    } else if (uri.startsWith("Qm") || uri.startsWith("bafy")) {
      url = `${PINATA_GATEWAY}/ipfs/${uri}`;
    } else if (uri.startsWith("http")) {
      url = uri;
    } else {
      return null;
    }

    const res = await fetch(url, { next: { revalidate: 300 } });
    if (!res.ok) return null;

    // Guard against oversized responses (1 MB limit)
    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > 1_000_000) return null;

    const json = (await res.json()) as Record<string, unknown>;
    const title =
      (typeof json.title === "string" && json.title) ||
      (typeof json.name === "string" && json.name) ||
      "";
    const description =
      (typeof json.description === "string" && json.description) || "";
    return {
      title,
      description,
    };
  } catch {
    return null;
  }
}

// ── Main fetch ─────────────────────────────────────────────

export async function fetchGovernorData(
  vaultAddress: Address,
): Promise<GovernorData | null> {
  const client = getPublicClient();

  // Step 1: Read governor address from vault
  let governorAddress: Address;
  try {
    governorAddress = (await client.readContract({
      address: vaultAddress,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "governor",
    })) as Address;
  } catch {
    return null;
  }

  if (
    !governorAddress ||
    governorAddress === "0x0000000000000000000000000000000000000000"
  ) {
    return null;
  }

  // Step 2: Read proposal count + governor params + active proposal + cooldown
  const baseResults = await client.multicall({
    contracts: [
      {
        address: governorAddress,
        abi: SYNDICATE_GOVERNOR_ABI,
        functionName: "proposalCount",
      },
      {
        address: governorAddress,
        abi: SYNDICATE_GOVERNOR_ABI,
        functionName: "getGovernorParams",
      },
      {
        address: governorAddress,
        abi: SYNDICATE_GOVERNOR_ABI,
        functionName: "getActiveProposal",
        args: [vaultAddress],
      },
      {
        address: governorAddress,
        abi: SYNDICATE_GOVERNOR_ABI,
        functionName: "getCooldownEnd",
        args: [vaultAddress],
      },
    ],
  });

  const proposalCount = (baseResults[0].result as bigint) ?? 0n;
  const paramsRaw = baseResults[1].result as GovernorParams | undefined;
  const params: GovernorParams = paramsRaw ?? {
    votingPeriod: 0n,
    executionWindow: 0n,
    quorumBps: 0n,
    maxPerformanceFeeBps: 0n,
    cooldownPeriod: 0n,
    collaborationWindow: 0n,
    maxCoProposers: 0n,
    minStrategyDuration: 0n,
    maxStrategyDuration: 0n,
  };
  const activeProposalId = (baseResults[2].result as bigint) ?? 0n;
  const cooldownEnd = (baseResults[3].result as bigint) ?? 0n;

  if (proposalCount === 0n) {
    return {
      governorAddress,
      proposals: [],
      activeProposalId,
      cooldownEnd,
      params,
    };
  }

  // Step 3: Batch-read all proposals
  const proposalIds = Array.from({ length: Number(proposalCount) }, (_, i) =>
    BigInt(i + 1),
  );

  const proposalCalls = proposalIds.flatMap((id) => [
    {
      address: governorAddress,
      abi: SYNDICATE_GOVERNOR_ABI,
      functionName: "getProposal" as const,
      args: [id] as const,
    },
    {
      address: governorAddress,
      abi: SYNDICATE_GOVERNOR_ABI,
      functionName: "getProposalState" as const,
      args: [id] as const,
    },
    {
      address: governorAddress,
      abi: SYNDICATE_GOVERNOR_ABI,
      functionName: "getCapitalSnapshot" as const,
      args: [id] as const,
    },
  ]);

  const proposalResults = await client.multicall({
    contracts: proposalCalls,
  });

  // Step 4: Parse results, filter by vault
  const allProposals: ProposalData[] = [];

  for (let i = 0; i < proposalIds.length; i++) {
    const baseIdx = i * 3;
    const proposalRaw = proposalResults[baseIdx];
    const stateRaw = proposalResults[baseIdx + 1];
    const capitalRaw = proposalResults[baseIdx + 2];

    if (proposalRaw.status !== "success" || !proposalRaw.result) continue;

    const p = proposalRaw.result as {
      id: bigint;
      proposer: Address;
      vault: Address;
      metadataURI: string;
      performanceFeeBps: bigint;
      splitIndex: bigint;
      strategyDuration: bigint;
      votesFor: bigint;
      votesAgainst: bigint;
      votesAbstain: bigint;
      snapshotTimestamp: bigint;
      voteEnd: bigint;
      executeBy: bigint;
      executedAt: bigint;
      state: number;
    };

    // Filter: only proposals targeting this vault
    if (p.vault.toLowerCase() !== vaultAddress.toLowerCase()) continue;

    const computedState =
      stateRaw.status === "success"
        ? (Number(stateRaw.result) as ProposalState)
        : (p.state as ProposalState);

    const capitalSnapshot =
      capitalRaw.status === "success"
        ? (capitalRaw.result as bigint)
        : 0n;

    allProposals.push({
      id: p.id,
      proposer: p.proposer,
      vault: p.vault,
      metadataURI: p.metadataURI,
      performanceFeeBps: p.performanceFeeBps,
      splitIndex: p.splitIndex,
      strategyDuration: p.strategyDuration,
      votesFor: p.votesFor,
      votesAgainst: p.votesAgainst,
      votesAbstain: p.votesAbstain,
      snapshotTimestamp: p.snapshotTimestamp,
      voteEnd: p.voteEnd,
      executeBy: p.executeBy,
      executedAt: p.executedAt,
      state: p.state as ProposalState,
      computedState,
      capitalSnapshot,
      metadata: null,
    });
  }

  // Step 5: Fetch IPFS metadata in parallel (graceful failures)
  await Promise.all(
    allProposals.map(async (proposal) => {
      if (proposal.metadataURI) {
        proposal.metadata = await fetchProposalMetadata(proposal.metadataURI);
      }
    }),
  );

  return {
    governorAddress,
    proposals: allProposals,
    activeProposalId,
    cooldownEnd,
    params,
  };
}

// ── Helpers ────────────────────────────────────────────────

export function formatDuration(seconds: bigint | number): string {
  const s = Number(seconds);
  if (s <= 0) return "0s";
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

export function formatTimeRemaining(endTimestamp: bigint): string {
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (endTimestamp <= now) return "Ended";
  return formatDuration(endTimestamp - now) + " remaining";
}

export function formatPnL(capitalSnapshot: bigint, currentBalance: bigint): string {
  const diff = currentBalance - capitalSnapshot;
  const formatted = formatUSDC(diff < 0n ? -diff : diff);
  return diff >= 0n ? `+${formatted}` : `-${formatted}`;
}
