/**
 * Server-side data fetching for the syndicate detail page.
 *
 * Multichain — tries all chains in CHAINS to resolve a subdomain,
 * then hydrates with onchain data, IPFS metadata, and ENS text records.
 */

import { cache } from "react";
import { type Address, namehash } from "viem";
import {
  CHAINS,
  type ChainEntry,
  getPublicClient,
  SYNDICATE_FACTORY_ABI,
  SYNDICATE_VAULT_ABI,
  ERC20_ABI,
  IDENTITY_REGISTRY_ABI,
  L2_REGISTRY_ABI,
  formatAsset,
  formatBps,
} from "./contracts";
import {
  fetchSyndicateAttestations,
  type AttestationItem,
} from "./eas-queries";

// ── Types ──────────────────────────────────────────────────

export type ActivityEventType =
  | "deposit"
  | "withdrawal"
  | "executed"
  | "settled"
  | "cancelled";

export interface ActivityEvent {
  type: ActivityEventType;
  actor: string;
  amount: bigint;
  timestamp: bigint;
  txHash: string;
  proposalId?: bigint;
  pnl?: bigint;
}

export interface AgentIdentity {
  name: string;
  description: string;
}

export interface AgentInfo {
  agentId: bigint;
  agentAddress: Address;
  active: boolean;
  identity: AgentIdentity | null;
}

export interface SyndicateMetadata {
  name: string;
  description: string;
  strategies: {
    id: string;
    name: string;
    protocols: string[];
    riskLevel: string;
  }[];
  terms: {
    ragequitEnabled: boolean;
    minDeposit?: string;
    feeModel?: string;
    lockPeriod?: number;
  };
  links?: {
    moltbook?: string;
    dashboard?: string;
    github?: string;
  };
}

export interface SyndicatePageData {
  // Factory data
  syndicateId: bigint;
  vault: Address;
  creator: Address;
  metadataURI: string;
  createdAt: bigint;
  active: boolean;
  subdomain: string;

  // Chain
  chainId: number;

  // Vault data
  totalAssets: bigint;
  totalSupply: bigint;
  agentCount: bigint;
  openDeposits: boolean;
  owner: Address;
  paused: boolean;
  redemptionsLocked: boolean;
  managementFeeBps: bigint;

  // Asset info
  assetAddress: Address;
  assetDecimals: number;
  assetSymbol: string;

  // Agent data
  agents: AgentInfo[];

  // IPFS metadata
  metadata: SyndicateMetadata | null;

  // ENS
  xmtpGroupId: string | null;

  // EAS attestations
  attestations: AttestationItem[];

  // Strategy activity feed
  activity: ActivityEvent[];

  // Equity curve (7 daily data points)
  equityCurve: number[];

  // Formatted display values
  display: {
    tvl: string;
    managementFee: string;
  };
}

// ── IPFS Metadata ──────────────────────────────────────────

const PINATA_GATEWAY =
  process.env.PINATA_GATEWAY || "https://sherwood.mypinata.cloud";

export async function fetchMetadata(
  ipfsURI: string,
): Promise<SyndicateMetadata | null> {
  try {
    let cid: string;
    if (ipfsURI.startsWith("ipfs://")) {
      cid = ipfsURI.slice(7);
    } else if (ipfsURI.startsWith("Qm") || ipfsURI.startsWith("bafy")) {
      cid = ipfsURI;
    } else {
      return null;
    }

    const response = await fetch(`${PINATA_GATEWAY}/ipfs/${cid}`, {
      next: { revalidate: 300 },
    });
    if (!response.ok) return null;
    return (await response.json()) as SyndicateMetadata;
  } catch {
    return null;
  }
}

// ── Agent discovery ─────────────────────────────────────────

/** Subgraph-based agent discovery (for chains with subgraph). */
async function fetchSubgraphAgents(
  subgraphUrl: string,
  syndicateId: string,
): Promise<Address[]> {
  try {
    const response = await fetch(subgraphUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          syndicate(id: "${syndicateId}") {
            agents(where: { active: true }) {
              id
              active
            }
          }
        }`,
      }),
      next: { revalidate: 60 },
    });
    if (!response.ok) return [];
    const result = await response.json();
    const agents = result?.data?.syndicate?.agents || [];
    // IDs are "{vault}-{agentAddress}" format
    return agents.map((a: { id: string }) => {
      const parts = a.id.split("-");
      return (parts.length > 1 ? parts.slice(1).join("-") : a.id) as Address;
    });
  } catch {
    return [];
  }
}

/** Onchain agent discovery via vault.getAgentAddresses(). */
async function fetchOnChainAgents(
  chainId: number,
  vault: Address,
): Promise<Address[]> {
  const client = getPublicClient(chainId);
  try {
    return (await client.readContract({
      address: vault,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "getAgentAddresses",
    })) as Address[];
  } catch {
    return [];
  }
}

// ── Main data fetching ─────────────────────────────────────

export const resolveSyndicateBySubdomain = cache(
  async function resolveSyndicateBySubdomain(
    subdomain: string,
  ): Promise<SyndicatePageData | null> {
  // Try all chains in parallel — first non-null wins
  const attempts = await Promise.all(
    Object.entries(CHAINS).map(async ([chainIdStr, entry]) => {
      const chainId = Number(chainIdStr);
      const client = getPublicClient(chainId);

      try {
        const syndicateId = (await client.readContract({
          address: entry.addresses.factory,
          abi: SYNDICATE_FACTORY_ABI,
          functionName: "subdomainToSyndicate",
          args: [subdomain],
        })) as bigint;

        if (!syndicateId || syndicateId === 0n) return null;
        return { chainId, entry, syndicateId };
      } catch {
        return null;
      }
    }),
  );

  const match = attempts.find((a) => a !== null);
  if (!match) return null;

  return resolveOnChain(match.chainId, match.entry, subdomain, match.syndicateId);
  },
);

async function resolveOnChain(
  chainId: number,
  entry: ChainEntry,
  subdomain: string,
  syndicateId: bigint,
): Promise<SyndicatePageData | null> {
  const client = getPublicClient(chainId);
  const addresses = entry.addresses;

  // Step 1: Get factory record
  let factoryRecord: readonly [
    bigint,
    Address,
    Address,
    string,
    bigint,
    boolean,
    string,
  ];
  try {
    factoryRecord = (await client.readContract({
      address: addresses.factory,
      abi: SYNDICATE_FACTORY_ABI,
      functionName: "syndicates",
      args: [syndicateId],
    })) as typeof factoryRecord;
  } catch {
    return null;
  }

  const [, vault, creator, metadataURI, createdAt, active] = factoryRecord;

  // Step 2: Multicall vault reads + asset address
  const vaultResults = await client.multicall({
    contracts: [
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "totalAssets" },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "totalSupply" },
      {
        address: vault,
        abi: SYNDICATE_VAULT_ABI,
        functionName: "getAgentCount",
      },
      {
        address: vault,
        abi: SYNDICATE_VAULT_ABI,
        functionName: "openDeposits",
      },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "owner" },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "paused" },
      {
        address: vault,
        abi: SYNDICATE_VAULT_ABI,
        functionName: "redemptionsLocked",
      },
      {
        address: vault,
        abi: SYNDICATE_VAULT_ABI,
        functionName: "managementFeeBps",
      },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "asset" },
    ],
  });

  const totalAssets = (vaultResults[0].result as bigint) ?? 0n;
  const totalSupply = (vaultResults[1].result as bigint) ?? 0n;
  const agentCount = (vaultResults[2].result as bigint) ?? 0n;
  const openDepositsVal = (vaultResults[3].result as boolean) ?? false;
  const owner = (vaultResults[4].result as Address) ?? creator;
  const paused = (vaultResults[5].result as boolean) ?? false;
  const redemptionsLocked = (vaultResults[6].result as boolean) ?? false;
  const managementFeeBps = (vaultResults[7].result as bigint) ?? 0n;
  const assetAddress = (vaultResults[8].result as Address) ?? addresses.usdc;

  // TVL is the onchain totalAssets — the vault's actual asset balance
  const effectiveTotalAssets = totalAssets;

  // Step 2c: Get asset decimals + symbol
  const assetInfoResults = await client.multicall({
    contracts: [
      { address: assetAddress, abi: ERC20_ABI, functionName: "decimals" },
      { address: assetAddress, abi: ERC20_ABI, functionName: "symbol" },
    ],
  });

  const assetDecimals =
    (assetInfoResults[0].result as number | undefined) ?? 18;
  const assetSymbol =
    (assetInfoResults[1].result as string | undefined) ?? "ETH";

  // Step 3: Fetch agent configs
  // Try subgraph first, fall back to onchain getAgentAddresses
  let agentAddresses: Address[];
  if (entry.subgraphUrl) {
    agentAddresses = await fetchSubgraphAgents(
      entry.subgraphUrl,
      syndicateId.toString(),
    );
    // Fall through to onchain if subgraph returned nothing but agentCount > 0
    if (agentAddresses.length === 0 && agentCount > 0n) {
      agentAddresses = await fetchOnChainAgents(chainId, vault);
    }
  } else {
    agentAddresses = await fetchOnChainAgents(chainId, vault);
  }

  const agents: AgentInfo[] = [];
  if (agentAddresses.length > 0) {
    const agentCalls = agentAddresses.map((addr) => ({
      address: vault,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "getAgentConfig" as const,
      args: [addr],
    }));

    const agentResults = await client.multicall({ contracts: agentCalls });
    for (const r of agentResults) {
      if (r.status !== "success" || !r.result) continue;
      const cfg = r.result as {
        agentId: bigint;
        agentAddress: Address;
        active: boolean;
      };
      if (!cfg.active) continue;
      agents.push({
        agentId: cfg.agentId,
        agentAddress: cfg.agentAddress,
        active: cfg.active,
        identity: null,
      });
    }
  }

  // Step 3b: Resolve ERC-8004 identities
  if (agents.length > 0 && addresses.identityRegistry !== "0x0000000000000000000000000000000000000000") {
    const identities = await resolveAgentIdentities(
      chainId,
      agents.map((a) => a.agentId),
      addresses.identityRegistry,
    );
    for (let i = 0; i < agents.length; i++) {
      agents[i].identity = identities[i] ?? null;
    }
  }

  // Step 4: Parallel off-chain reads
  const [metadata, xmtpGroupId, attestations, activity, equityCurve] = await Promise.all([
    fetchMetadata(metadataURI),
    fetchXmtpGroupId(chainId, subdomain, addresses.l2Registry),
    fetchSyndicateAttestations(creator, syndicateId, chainId, vault),
    fetchStrategyActivity(entry.subgraphUrl, syndicateId.toString()),
    fetchEquityCurve(entry.subgraphUrl, syndicateId.toString(), assetDecimals, effectiveTotalAssets),
  ]);

  // Format display values based on asset
  const isUSD = assetSymbol === "USDC" || assetSymbol === "USDT";
  const tvlFormatted = formatAsset(
    effectiveTotalAssets,
    assetDecimals,
    isUSD ? "USD" : undefined,
  );
  return {
    syndicateId,
    vault,
    creator,
    metadataURI,
    createdAt,
    active,
    subdomain,
    chainId,
    totalAssets: effectiveTotalAssets,
    totalSupply,
    agentCount,
    openDeposits: openDepositsVal,
    owner,
    paused,
    redemptionsLocked,
    managementFeeBps,
    assetAddress,
    assetDecimals,
    assetSymbol,
    agents,
    metadata,
    xmtpGroupId,
    attestations,
    activity,
    equityCurve,
    display: {
      tvl: isUSD ? tvlFormatted : `${tvlFormatted} ${assetSymbol}`,
      managementFee: formatBps(managementFeeBps),
    },
  };
}

// ── ERC-8004 Agent Identity Resolution ─────────────────────

export async function resolveAgentIdentities(
  chainId: number,
  agentIds: bigint[],
  registryAddress: Address,
): Promise<(AgentIdentity | null)[]> {
  const client = getPublicClient(chainId);

  const uriCalls = agentIds.map((id) => ({
    address: registryAddress,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "tokenURI" as const,
    args: [id],
  }));

  const uriResults = await client.multicall({ contracts: uriCalls });

  return Promise.all(
    uriResults.map(async (r) => {
      if (r.status !== "success" || !r.result) return null;
      const uri = r.result as string;
      return parseAgentMetadata(uri);
    }),
  );
}

/** Parse agent metadata from a tokenURI (base64 data URI, IPFS, or HTTP). */
async function parseAgentMetadata(uri: string): Promise<AgentIdentity | null> {
  try {
    let json: Record<string, unknown>;

    if (uri.startsWith("data:application/json;base64,")) {
      const b64 = uri.slice("data:application/json;base64,".length);
      const decoded = atob(b64);
      json = JSON.parse(decoded);
    } else if (uri.startsWith("data:application/json,")) {
      const raw = uri.slice("data:application/json,".length);
      json = JSON.parse(decodeURIComponent(raw));
    } else if (
      uri.startsWith("ipfs://") ||
      uri.startsWith("Qm") ||
      uri.startsWith("bafy")
    ) {
      const cid = uri.startsWith("ipfs://") ? uri.slice(7) : uri;
      const gateway =
        process.env.PINATA_GATEWAY || "https://sherwood.mypinata.cloud";
      const res = await fetch(`${gateway}/ipfs/${cid}`, {
        next: { revalidate: 300 },
      });
      if (!res.ok) return null;
      json = await res.json();
    } else if (uri.startsWith("http")) {
      const res = await fetch(uri, { next: { revalidate: 300 } });
      if (!res.ok) return null;
      json = await res.json();
    } else {
      return null;
    }

    return {
      name: (json.name as string) || "",
      description: (json.description as string) || "",
    };
  } catch {
    return null;
  }
}

// ── Strategy activity feed ─────────────────────────────────

async function fetchStrategyActivity(
  subgraphUrl: string | null,
  syndicateId: string,
): Promise<ActivityEvent[]> {
  if (!subgraphUrl) return [];

  try {
    const response = await fetch(subgraphUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          deposits(
            where: { syndicate: "${syndicateId}" }
            orderBy: timestamp
            orderDirection: desc
            first: 20
          ) {
            sender
            assets
            timestamp
            txHash
          }
          withdrawals(
            where: { syndicate: "${syndicateId}" }
            orderBy: timestamp
            orderDirection: desc
            first: 20
          ) {
            owner
            assets
            timestamp
            txHash
          }
          proposals(
            where: { syndicate: "${syndicateId}", state_in: ["Executed", "Settled", "Cancelled"] }
            orderBy: createdAt
            orderDirection: desc
            first: 20
          ) {
            id
            proposer
            capitalSnapshot
            finalPnl
            state
            executedAt
            settledAt
            createdAt
            txHash
          }
        }`,
      }),
      next: { revalidate: 60 },
    });

    if (!response.ok) return [];
    const result = await response.json();
    const data = result?.data;
    if (!data) return [];

    const events: ActivityEvent[] = [];

    for (const d of data.deposits ?? []) {
      events.push({
        type: "deposit",
        actor: d.sender,
        amount: BigInt(d.assets),
        timestamp: BigInt(d.timestamp),
        txHash: d.txHash,
      });
    }

    for (const w of data.withdrawals ?? []) {
      events.push({
        type: "withdrawal",
        actor: w.owner,
        amount: BigInt(w.assets),
        timestamp: BigInt(w.timestamp),
        txHash: w.txHash,
      });
    }

    for (const p of data.proposals ?? []) {
      const state = p.state as string;
      if (state === "Executed" && p.executedAt) {
        events.push({
          type: "executed",
          actor: p.proposer,
          amount: p.capitalSnapshot ? BigInt(p.capitalSnapshot) : 0n,
          timestamp: BigInt(p.executedAt),
          txHash: p.txHash,
          proposalId: BigInt(p.id),
        });
      }
      if (state === "Settled" && p.settledAt) {
        events.push({
          type: "settled",
          actor: p.proposer,
          amount: p.capitalSnapshot ? BigInt(p.capitalSnapshot) : 0n,
          timestamp: BigInt(p.settledAt),
          txHash: p.txHash,
          proposalId: BigInt(p.id),
          pnl: p.finalPnl != null ? BigInt(p.finalPnl) : undefined,
        });
      }
      if (state === "Cancelled") {
        const ts = p.executedAt ?? p.settledAt ?? p.createdAt;
        if (!ts || ts === "0") continue;
        events.push({
          type: "cancelled",
          actor: p.proposer,
          amount: 0n,
          timestamp: BigInt(ts),
          txHash: p.txHash,
          proposalId: BigInt(p.id),
        });
      }
    }

    // Sort by timestamp desc, take 20 most recent
    events.sort((a, b) => (b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0));
    return events.slice(0, 20);
  } catch {
    return [];
  }
}

// ── Equity curve ──────────────────────────────────────────

async function fetchEquityCurve(
  subgraphUrl: string | null,
  syndicateId: string,
  assetDecimals: number,
  currentTotalAssets: bigint,
): Promise<number[]> {
  const currentTVL = Number(currentTotalAssets) / 10 ** assetDecimals;

  if (!subgraphUrl) return [currentTVL];

  try {
    const response = await fetch(subgraphUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          deposits(
            where: { syndicate: "${syndicateId}" }
            orderBy: timestamp
            orderDirection: asc
            first: 1000
          ) {
            assets
            timestamp
          }
          withdrawals(
            where: { syndicate: "${syndicateId}" }
            orderBy: timestamp
            orderDirection: asc
            first: 1000
          ) {
            assets
            timestamp
          }
          proposals(
            where: { syndicate: "${syndicateId}", state: "Settled" }
            orderBy: settledAt
            orderDirection: asc
            first: 1000
          ) {
            finalPnl
            settledAt
          }
        }`,
      }),
      next: { revalidate: 60 },
    });

    if (!response.ok) return [currentTVL];
    const result = await response.json();
    const data = result?.data;
    if (!data) return [currentTVL];

    // Build chronological event list
    const events: { timestamp: number; delta: bigint }[] = [];

    for (const d of data.deposits ?? []) {
      events.push({ timestamp: Number(d.timestamp), delta: BigInt(d.assets) });
    }
    for (const w of data.withdrawals ?? []) {
      events.push({ timestamp: Number(w.timestamp), delta: -BigInt(w.assets) });
    }
    for (const p of data.proposals ?? []) {
      if (p.finalPnl != null && p.settledAt) {
        events.push({ timestamp: Number(p.settledAt), delta: BigInt(p.finalPnl) });
      }
    }

    if (events.length === 0) return [currentTVL];

    events.sort((a, b) => a.timestamp - b.timestamp);

    // Compute cumulative TVL at each event
    let runningTVL = 0n;
    const tvlPoints: { timestamp: number; tvl: bigint }[] = [];
    for (const evt of events) {
      runningTVL += evt.delta;
      if (runningTVL < 0n) runningTVL = 0n;
      tvlPoints.push({ timestamp: evt.timestamp, tvl: runningTVL });
    }

    // Sample into 7 daily buckets
    const now = Math.floor(Date.now() / 1000);
    const DAY = 86400;
    const days = 7;
    const curve: number[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const dayEnd = now - i * DAY;
      // Find the last TVL point at or before this day's end
      let dayTVL = 0n;
      for (const p of tvlPoints) {
        if (p.timestamp <= dayEnd) {
          dayTVL = p.tvl;
        } else {
          break;
        }
      }
      curve.push(Number(dayTVL) / 10 ** assetDecimals);
    }

    // Replace last point with actual onchain TVL for accuracy
    curve[curve.length - 1] = currentTVL;

    return curve;
  } catch {
    return [currentTVL];
  }
}

// ── ENS text record ────────────────────────────────────────

async function fetchXmtpGroupId(
  chainId: number,
  subdomain: string,
  l2Registry: Address,
): Promise<string | null> {
  if (l2Registry === "0x0000000000000000000000000000000000000000")
    return null;

  const client = getPublicClient(chainId);
  const node = namehash(`${subdomain}.sherwoodagent.eth`);

  try {
    const groupId = (await client.readContract({
      address: l2Registry,
      abi: L2_REGISTRY_ABI,
      functionName: "text",
      args: [node, "xmtpGroupId"],
    })) as string;

    return groupId || null;
  } catch {
    return null;
  }
}
