/**
 * Server-side data fetching for the syndicate detail page.
 *
 * Resolves a subdomain to on-chain syndicate data via multicall,
 * then hydrates with IPFS metadata and ENS text records.
 */

import { type Address, namehash } from "viem";
import {
  getPublicClient,
  getAddresses,
  SYNDICATE_FACTORY_ABI,
  SYNDICATE_VAULT_ABI,
  IDENTITY_REGISTRY_ABI,
  L2_REGISTRY_ABI,
  formatUSDC,
} from "./contracts";
import { fetchSyndicateAttestations, type AttestationItem } from "./eas-queries";

// ── Types ──────────────────────────────────────────────────

export interface AgentIdentity {
  name: string;
  description: string;
}

export interface AgentInfo {
  agentId: bigint;
  pkpAddress: Address;
  operatorEOA: Address;
  maxPerTx: bigint;
  dailyLimit: bigint;
  spentToday: bigint;
  active: boolean;
  identity: AgentIdentity | null;
}

export interface SyndicateCaps {
  maxPerTx: bigint;
  maxDailyTotal: bigint;
  maxBorrowRatio: bigint;
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

  // Vault data
  totalAssets: bigint;
  totalSupply: bigint;
  totalDeposited: bigint;
  caps: SyndicateCaps;
  agentCount: bigint;
  dailySpendTotal: bigint;
  allowedTargets: Address[];
  openDeposits: boolean;
  owner: Address;
  paused: boolean;

  // Agent data (from subgraph PKPs + on-chain getAgentConfig)
  agents: AgentInfo[];

  // IPFS metadata
  metadata: SyndicateMetadata | null;

  // ENS
  xmtpGroupId: string | null;

  // EAS attestations
  attestations: AttestationItem[];

  // Formatted display values
  display: {
    tvl: string;
    totalDeposited: string;
    dailySpend: string;
    maxDailyTotal: string;
  };
}

// ── IPFS Metadata ──────────────────────────────────────────

const PINATA_GATEWAY =
  process.env.PINATA_GATEWAY || "https://sherwood.mypinata.cloud";

async function fetchMetadata(
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

// ── Subgraph query for agent PKP addresses ─────────────────

const SUBGRAPH_URLS: Record<string, string> = {
  "84532":
    "https://api.studio.thegraph.com/query/18207/sherwood-sepolia/version/latest",
};

function getSubgraphUrl(): string | undefined {
  if (process.env.SUBGRAPH_URL) return process.env.SUBGRAPH_URL;
  const chainId = process.env.CHAIN_ID || "84532";
  return SUBGRAPH_URLS[chainId];
}

interface SubgraphAgent {
  id: string;
  active: boolean;
}

async function fetchSubgraphAgents(
  syndicateId: string,
): Promise<SubgraphAgent[]> {
  const url = getSubgraphUrl();
  if (!url) return [];

  try {
    const response = await fetch(url, {
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
    return result?.data?.syndicate?.agents || [];
  } catch {
    return [];
  }
}

// ── Main data fetching ─────────────────────────────────────

export async function resolveSyndicateBySubdomain(
  subdomain: string,
): Promise<SyndicatePageData | null> {
  const client = getPublicClient();
  const addresses = getAddresses();

  // Step 1: Resolve subdomain → syndicateId
  let syndicateId: bigint;
  try {
    syndicateId = (await client.readContract({
      address: addresses.factory,
      abi: SYNDICATE_FACTORY_ABI,
      functionName: "subdomainToSyndicate",
      args: [subdomain],
    })) as bigint;
  } catch {
    return null;
  }

  if (syndicateId === 0n) return null;

  // Step 2: Get factory record
  let factoryRecord: readonly [bigint, Address, Address, string, bigint, boolean, string];
  try {
    factoryRecord = (await client.readContract({
      address: addresses.factory,
      abi: SYNDICATE_FACTORY_ABI,
      functionName: "syndicates",
      args: [syndicateId],
    })) as readonly [bigint, Address, Address, string, bigint, boolean, string];
  } catch {
    return null;
  }

  const [, vault, creator, metadataURI, createdAt, active] = factoryRecord;

  // Step 3: Multicall vault reads
  const vaultResults = await client.multicall({
    contracts: [
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "totalAssets" },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "totalSupply" },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "totalDeposited" },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "getSyndicateCaps" },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "getAgentCount" },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "getDailySpendTotal" },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "getAllowedTargets" },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "openDeposits" },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "owner" },
      { address: vault, abi: SYNDICATE_VAULT_ABI, functionName: "paused" },
    ],
  });

  const totalAssets = (vaultResults[0].result as bigint) ?? 0n;
  const totalSupply = (vaultResults[1].result as bigint) ?? 0n;
  const totalDeposited = (vaultResults[2].result as bigint) ?? 0n;
  const capsRaw = vaultResults[3].result as { maxPerTx: bigint; maxDailyTotal: bigint; maxBorrowRatio: bigint } | undefined;
  const caps: SyndicateCaps = capsRaw ?? { maxPerTx: 0n, maxDailyTotal: 0n, maxBorrowRatio: 0n };
  const agentCount = (vaultResults[4].result as bigint) ?? 0n;
  const dailySpendTotal = (vaultResults[5].result as bigint) ?? 0n;
  const allowedTargets = (vaultResults[6].result as Address[]) ?? [];
  const openDepositsVal = (vaultResults[7].result as boolean) ?? false;
  const owner = (vaultResults[8].result as Address) ?? creator;
  const paused = (vaultResults[9].result as boolean) ?? false;

  // Step 4: Fetch agent configs
  // Try subgraph first for PKP addresses, fall back to event logs
  const subgraphAgents = await fetchSubgraphAgents(syndicateId.toString());
  let agents: AgentInfo[] = [];

  // Get PKP addresses from subgraph — IDs are "{vault}-{pkpAddress}" format
  const pkpAddresses: Address[] = subgraphAgents.map((a) => {
    const parts = a.id.split("-");
    // Extract PKP address (last part after vault address)
    return (parts.length > 1 ? parts.slice(1).join("-") : a.id) as Address;
  });

  if (pkpAddresses.length > 0) {
    const agentCalls = pkpAddresses.map((pkp) => ({
      address: vault,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "getAgentConfig" as const,
      args: [pkp],
    }));

    const agentResults = await client.multicall({ contracts: agentCalls });
    for (const r of agentResults) {
      if (r.status !== "success" || !r.result) continue;
      const cfg = r.result as {
        agentId: bigint;
        pkpAddress: Address;
        operatorEOA: Address;
        maxPerTx: bigint;
        dailyLimit: bigint;
        spentToday: bigint;
        lastResetDay: bigint;
        active: boolean;
      };
      if (!cfg.active) continue;
      agents.push({
        agentId: cfg.agentId,
        pkpAddress: cfg.pkpAddress,
        operatorEOA: cfg.operatorEOA,
        maxPerTx: cfg.maxPerTx,
        dailyLimit: cfg.dailyLimit,
        spentToday: cfg.spentToday,
        active: cfg.active,
        identity: null,
      });
    }
  }

  // Step 4b: Resolve ERC-8004 identities for each agent
  if (agents.length > 0) {
    const identities = await resolveAgentIdentities(
      agents.map((a) => a.agentId),
      addresses.identityRegistry,
    );
    for (let i = 0; i < agents.length; i++) {
      agents[i].identity = identities[i] ?? null;
    }
  }

  // Step 5: Parallel off-chain reads
  const [metadata, xmtpGroupId, attestations] = await Promise.all([
    fetchMetadata(metadataURI),
    fetchXmtpGroupId(subdomain, addresses.l2Registry),
    fetchSyndicateAttestations(creator, syndicateId),
  ]);

  return {
    syndicateId,
    vault,
    creator,
    metadataURI,
    createdAt,
    active,
    subdomain,
    totalAssets,
    totalSupply,
    totalDeposited,
    caps,
    agentCount,
    dailySpendTotal,
    allowedTargets,
    openDeposits: openDepositsVal,
    owner,
    paused,
    agents,
    metadata,
    xmtpGroupId,
    attestations,
    display: {
      tvl: formatUSDC(totalAssets),
      totalDeposited: formatUSDC(totalDeposited),
      dailySpend: formatUSDC(dailySpendTotal),
      maxDailyTotal: formatUSDC(caps.maxDailyTotal),
    },
  };
}

// ── ERC-8004 Agent Identity Resolution ─────────────────────

async function resolveAgentIdentities(
  agentIds: bigint[],
  registryAddress: Address,
): Promise<(AgentIdentity | null)[]> {
  if (registryAddress === "0x0000000000000000000000000000000000000000") {
    return agentIds.map(() => null);
  }

  const client = getPublicClient();

  // Multicall tokenURI for all agents
  const uriCalls = agentIds.map((id) => ({
    address: registryAddress,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "tokenURI" as const,
    args: [id],
  }));

  const uriResults = await client.multicall({ contracts: uriCalls });

  // Resolve each URI to metadata in parallel
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
      // Base64-encoded JSON data URI
      const b64 = uri.slice("data:application/json;base64,".length);
      const decoded = atob(b64);
      json = JSON.parse(decoded);
    } else if (uri.startsWith("data:application/json,")) {
      // URL-encoded JSON data URI
      const raw = uri.slice("data:application/json,".length);
      json = JSON.parse(decodeURIComponent(raw));
    } else if (uri.startsWith("ipfs://") || uri.startsWith("Qm") || uri.startsWith("bafy")) {
      // IPFS URI — resolve via Pinata gateway
      const cid = uri.startsWith("ipfs://") ? uri.slice(7) : uri;
      const gateway = process.env.PINATA_GATEWAY || "https://sherwood.mypinata.cloud";
      const res = await fetch(`${gateway}/ipfs/${cid}`, { next: { revalidate: 300 } });
      if (!res.ok) return null;
      json = await res.json();
    } else if (uri.startsWith("http")) {
      // HTTP URI
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

// ── ENS text record ────────────────────────────────────────

async function fetchXmtpGroupId(
  subdomain: string,
  l2Registry: Address,
): Promise<string | null> {
  if (l2Registry === "0x0000000000000000000000000000000000000000") return null;

  const client = getPublicClient();
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
