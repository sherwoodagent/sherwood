/**
 * Server-side syndicate data fetching.
 *
 * Multichain — fetches syndicates from ALL chains in CHAINS simultaneously.
 * Uses subgraph where available, falls back to onchain factory.getActiveSyndicates().
 */

import { type Address } from "viem";
import {
  CHAINS,
  type ChainEntry,
  getPublicClient,
  getAddresses,
  SYNDICATE_FACTORY_ABI,
  SYNDICATE_VAULT_ABI,
  SYNDICATE_GOVERNOR_ABI,
  ERC20_ABI,
  formatAsset,
} from "./contracts";
import { fetchMetadata, resolveAgentIdentities } from "./syndicate-data";

// ── Types ──────────────────────────────────────────────────

interface SubgraphSyndicate {
  id: string;
  vault: string;
  creator: string;
  subdomain: string;
  metadataURI: string;
  createdAt: string;
  active: boolean;
  totalDeposits: string;
  totalWithdrawals: string;
  agents: { id: string; agentAddress: string; agentId: string; active: boolean }[];
  proposals: { proposer: string; finalPnl: string | null; state: string }[];
}

export interface AgentDisplay {
  agentAddress: string;
  agentId: string;
  agentName?: string;
  proposalCount: number;
  totalPnl: string; // formatted P&L string
  totalPnlRaw: number; // raw number for sorting
}

export interface SyndicateDisplay {
  id: string;
  vault: string;
  subdomain: string;
  name: string;
  strategy: string;
  tvl: string;
  agentCount: number;
  agents: AgentDisplay[];
  proposalCount: number;
  status: "ACTIVE_STRATEGY" | "VOTING" | "IDLE" | "NO_AGENTS";
  chainId: number;
}

// ── Subgraph ───────────────────────────────────────────────

async function querySubgraph<T>(
  url: string,
  graphql: string,
): Promise<T | null> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: graphql }),
      next: { revalidate: 60 },
    });

    if (!response.ok) return null;

    const result = (await response.json()) as {
      data?: T;
      errors?: { message: string }[];
    };

    if (result.errors?.length || !result.data) return null;
    return result.data;
  } catch {
    return null;
  }
}

// ── Proposal-aware status ─────────────────────────────────

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/**
 * Resolve proposal-aware status for a list of vaults.
 * Returns a map from lowercase vault address → "VOTING" | "ACTIVE_STRATEGY".
 * Vaults with no active/voting proposal (or no governor) are absent from the map.
 *
 * `getActiveProposal(vault)` only returns non-zero for Executed proposals.
 * To detect Pending/Approved (voting) proposals we also scan recent proposals
 * via `proposalCount()` + `getProposal(id)`.
 */
async function resolveProposalStatuses(
  chainId: number,
  vaults: Address[],
): Promise<Map<string, "VOTING" | "ACTIVE_STRATEGY">> {
  const statusMap = new Map<string, "VOTING" | "ACTIVE_STRATEGY">();
  if (vaults.length === 0) return statusMap;

  const client = getPublicClient(chainId);

  // 1. Get governor address from each vault
  const govResults = await client.multicall({
    contracts: vaults.map((v) => ({
      address: v,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "governor" as const,
    })),
  });

  const govVaults: { vault: Address; governor: Address }[] = [];
  for (let i = 0; i < vaults.length; i++) {
    const r = govResults[i];
    if (r.status === "success" && r.result && r.result !== ZERO_ADDR) {
      govVaults.push({ vault: vaults[i], governor: r.result as Address });
    }
  }
  if (govVaults.length === 0) return statusMap;

  // 2. Get active proposal ID for each vault + proposalCount from governor
  //    (all vaults share the same governor, so we only need proposalCount once)
  const governorAddress = govVaults[0].governor;

  const [activeResults, countResult] = await Promise.all([
    client.multicall({
      contracts: govVaults.map((gv) => ({
        address: gv.governor,
        abi: SYNDICATE_GOVERNOR_ABI,
        functionName: "getActiveProposal" as const,
        args: [gv.vault] as const,
      })),
    }),
    client.readContract({
      address: governorAddress,
      abi: SYNDICATE_GOVERNOR_ABI,
      functionName: "proposalCount",
    }).catch(() => 0n),
  ]);

  const proposalCount = Number(countResult);

  // Mark vaults with an executed active proposal
  const vaultSet = new Set(govVaults.map((gv) => gv.vault.toLowerCase()));
  for (let i = 0; i < govVaults.length; i++) {
    const r = activeResults[i];
    if (r.status === "success") {
      const pid = r.result as bigint;
      if (pid > 0n) {
        statusMap.set(govVaults[i].vault.toLowerCase(), "ACTIVE_STRATEGY");
      }
    }
  }

  // 3. Scan recent proposals to detect Pending/Approved (voting) state.
  //    Only needed for vaults not already marked. Scan last N proposals
  //    (enough to cover all vaults with potential voting proposals).
  const unresolvedVaults = govVaults.filter(
    (gv) => !statusMap.has(gv.vault.toLowerCase()),
  );

  if (unresolvedVaults.length > 0 && proposalCount > 0) {
    // Scan the last (vaults.length * 3) proposals or all if fewer exist
    const scanCount = Math.min(proposalCount, vaults.length * 3);
    const startId = proposalCount - scanCount + 1;

    const proposalCalls = [];
    for (let id = startId; id <= proposalCount; id++) {
      proposalCalls.push({
        address: governorAddress,
        abi: SYNDICATE_GOVERNOR_ABI,
        functionName: "getProposal" as const,
        args: [BigInt(id)] as const,
      });
    }

    const proposalResults = await client.multicall({ contracts: proposalCalls });

    for (const r of proposalResults) {
      if (r.status !== "success" || !r.result) continue;
      const p = r.result as {
        vault: Address;
        state: number;
      };
      const key = p.vault.toLowerCase();
      // Only care about vaults we're tracking that aren't already resolved
      if (!vaultSet.has(key) || statusMap.has(key)) continue;
      const state = Number(p.state);
      if (state === 1 || state === 2) {
        statusMap.set(key, "VOTING");
      }
    }
  }

  return statusMap;
}

// ── Per-chain fetchers ────────────────────────────────────

async function fetchViaSubgraph(
  chainId: number,
  subgraphUrl: string,
): Promise<SyndicateDisplay[]> {
  const data = await querySubgraph<{ syndicates: SubgraphSyndicate[] }>(
    subgraphUrl,
    `{
      syndicates(
        where: { active: true }
        orderBy: createdAt
        orderDirection: desc
        first: 20
      ) {
        id
        vault
        creator
        subdomain
        metadataURI
        createdAt
        active
        totalDeposits
        totalWithdrawals
        agents(where: { active: true }) {
          id
          agentAddress
          agentId
          active
        }
        proposals {
          proposer
          finalPnl
          state
        }
      }
    }`,
  );

  if (!data?.syndicates?.length) return [];

  const client = getPublicClient(chainId);

  // Multicall totalAssets + asset for each vault to get real TVL
  const vaultCalls = data.syndicates.flatMap((s) => [
    {
      address: s.vault as Address,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "totalAssets" as const,
    },
    {
      address: s.vault as Address,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "asset" as const,
    },
  ]);

  const vaultResults = await client.multicall({ contracts: vaultCalls });

  // Collect unique asset addresses for decimals + symbol lookup
  const assetAddresses = new Set<Address>();
  for (let i = 0; i < data.syndicates.length; i++) {
    const assetResult = vaultResults[i * 2 + 1];
    if (assetResult.status === "success" && assetResult.result) {
      assetAddresses.add(assetResult.result as Address);
    }
  }

  const assetList = [...assetAddresses];
  const assetInfoCalls = assetList.flatMap((addr) => [
    { address: addr, abi: ERC20_ABI, functionName: "decimals" as const },
    { address: addr, abi: ERC20_ABI, functionName: "symbol" as const },
  ]);

  const assetInfoResults =
    assetList.length > 0
      ? await client.multicall({ contracts: assetInfoCalls })
      : [];

  const assetInfo: Record<string, { decimals: number; symbol: string }> = {};
  for (let i = 0; i < assetList.length; i++) {
    const decimals = assetInfoResults[i * 2]?.result as number | undefined;
    const symbol = assetInfoResults[i * 2 + 1]?.result as string | undefined;
    assetInfo[assetList[i].toLowerCase()] = {
      decimals: decimals ?? 18,
      symbol: symbol ?? "ETH",
    };
  }

  // Resolve proposal-aware statuses for all vaults
  const vaultAddresses = data.syndicates.map((s) => s.vault as Address);
  const proposalStatuses = await resolveProposalStatuses(chainId, vaultAddresses);

  // Resolve ERC-8004 identities for all agents across syndicates
  const allAgents = data.syndicates.flatMap((s) => s.agents || []);
  const addresses = getAddresses(chainId);
  const identityMap: Record<string, string> = {};
  if (allAgents.length > 0 && addresses.identityRegistry !== ZERO_ADDR) {
    const uniqueIds = [...new Set(allAgents.map((a) => BigInt(a.agentId)))];
    const identities = await resolveAgentIdentities(
      chainId,
      uniqueIds,
      addresses.identityRegistry,
    );
    for (let i = 0; i < uniqueIds.length; i++) {
      if (identities[i]?.name) {
        identityMap[uniqueIds[i].toString()] = identities[i]!.name;
      }
    }
  }

  return Promise.all(
    data.syndicates.map(async (s, i) => {
      const metadata = await fetchMetadata(s.metadataURI);

      const totalAssets = (vaultResults[i * 2]?.result as bigint) ?? 0n;
      const assetAddr = (vaultResults[i * 2 + 1]?.result as Address) ?? "";
      const info = assetInfo[assetAddr.toLowerCase()] ?? {
        decimals: 18,
        symbol: "ETH",
      };
      const agentCount = s.agents?.length || 0;

      const strategy =
        metadata?.strategies?.[0]?.name ||
        metadata?.strategies?.[0]?.protocols?.join(" + ") ||
        "—";

      let status: SyndicateDisplay["status"] = "NO_AGENTS";
      if (agentCount > 0) {
        status = proposalStatuses.get(s.vault.toLowerCase()) ?? "IDLE";
      }

      const tvlFormatted = formatAsset(
        totalAssets,
        info.decimals,
        undefined,
      );

      // Aggregate proposals per agent: count all, sum P&L only for settled
      const isUSD = info.symbol === "USDC" || info.symbol === "USDT";
      const agentPnl: Record<string, { count: number; pnl: bigint }> = {};
      for (const p of s.proposals || []) {
        const key = p.proposer.toLowerCase();
        if (!agentPnl[key]) agentPnl[key] = { count: 0, pnl: 0n };
        agentPnl[key].count++;
        if (p.state === "Settled" && p.finalPnl != null) {
          agentPnl[key].pnl += BigInt(p.finalPnl);
        }
      }

      return {
        id: s.id,
        vault: s.vault,
        subdomain: s.subdomain,
        name: metadata?.name || `Syndicate #${s.id}`,
        strategy,
        tvl: `${tvlFormatted} ${info.symbol}`,
        agentCount,
        proposalCount: (s.proposals || []).length,
        agents: (s.agents || []).map((a) => {
          const stats = agentPnl[a.agentAddress.toLowerCase()] ?? { count: 0, pnl: 0n };
          const pnlAbs = stats.pnl < 0n ? -stats.pnl : stats.pnl;
          const pnlFormatted = formatAsset(pnlAbs, info.decimals, isUSD ? "USD" : undefined);
          const sign = stats.pnl > 0n ? "+" : stats.pnl < 0n ? "-" : "";
          const pnlDisplay = isUSD ? `${sign}${pnlFormatted}` : `${sign}${pnlFormatted} ${info.symbol}`;
          return {
            agentAddress: a.agentAddress,
            agentId: a.agentId,
            agentName: identityMap[a.agentId],
            proposalCount: stats.count,
            totalPnl: stats.count > 0 ? pnlDisplay : "—",
            totalPnlRaw: Number(stats.pnl) / 10 ** info.decimals,
          };
        }),
        status,
        chainId,
      };
    }),
  );
}

async function fetchViaOnChain(
  chainId: number,
  entry: ChainEntry,
): Promise<SyndicateDisplay[]> {
  const client = getPublicClient(chainId);

  // Call factory.getActiveSyndicates()
  let rawSyndicates: readonly {
    id: bigint;
    vault: Address;
    creator: Address;
    metadataURI: string;
    createdAt: bigint;
    active: boolean;
    subdomain: string;
  }[];

  try {
    rawSyndicates = (await client.readContract({
      address: entry.addresses.factory,
      abi: SYNDICATE_FACTORY_ABI,
      functionName: "getAllActiveSyndicates",
    })) as typeof rawSyndicates;
  } catch {
    return [];
  }

  if (!rawSyndicates.length) return [];

  // For each syndicate, multicall vault data: totalAssets, getAgentCount, asset, getAgentAddresses
  const vaultCalls = rawSyndicates.flatMap((s) => [
    {
      address: s.vault,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "totalAssets" as const,
    },
    {
      address: s.vault,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "getAgentCount" as const,
    },
    {
      address: s.vault,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "asset" as const,
    },
    {
      address: s.vault,
      abi: SYNDICATE_VAULT_ABI,
      functionName: "getAgentAddresses" as const,
    },
  ]);

  const vaultResults = await client.multicall({ contracts: vaultCalls });

  // Collect unique asset addresses for decimals + symbol lookup
  const assetAddresses = new Set<Address>();
  for (let i = 0; i < rawSyndicates.length; i++) {
    const assetResult = vaultResults[i * 4 + 2];
    if (assetResult.status === "success" && assetResult.result) {
      assetAddresses.add(assetResult.result as Address);
    }
  }

  // Multicall decimals + symbol for each unique asset
  const assetList = [...assetAddresses];
  const assetInfoCalls = assetList.flatMap((addr) => [
    { address: addr, abi: ERC20_ABI, functionName: "decimals" as const },
    { address: addr, abi: ERC20_ABI, functionName: "symbol" as const },
  ]);

  const assetInfoResults =
    assetList.length > 0
      ? await client.multicall({ contracts: assetInfoCalls })
      : [];

  const assetInfo: Record<string, { decimals: number; symbol: string }> = {};
  for (let i = 0; i < assetList.length; i++) {
    const decimals = assetInfoResults[i * 2]?.result as number | undefined;
    const symbol = assetInfoResults[i * 2 + 1]?.result as string | undefined;
    assetInfo[assetList[i].toLowerCase()] = {
      decimals: decimals ?? 18,
      symbol: symbol ?? "ETH",
    };
  }

  // Batch-fetch agentConfig for all agents across all syndicates
  const allAgentCalls: { vault: Address; agentAddress: Address }[] = [];
  for (let i = 0; i < rawSyndicates.length; i++) {
    const agentAddresses = (vaultResults[i * 4 + 3]?.result as Address[]) ?? [];
    for (const addr of agentAddresses) {
      allAgentCalls.push({ vault: rawSyndicates[i].vault, agentAddress: addr });
    }
  }

  const agentConfigResults =
    allAgentCalls.length > 0
      ? await client.multicall({
          contracts: allAgentCalls.map((c) => ({
            address: c.vault,
            abi: SYNDICATE_VAULT_ABI,
            functionName: "getAgentConfig" as const,
            args: [c.agentAddress],
          })),
        })
      : [];

  // Index agent configs by vault address
  const agentsByVault: Record<string, AgentDisplay[]> = {};
  const allAgentIds: bigint[] = [];
  const agentIdToIndex: { vaultKey: string; idx: number; agentId: bigint }[] = [];
  let configIdx = 0;
  for (let i = 0; i < rawSyndicates.length; i++) {
    const agentAddresses = (vaultResults[i * 4 + 3]?.result as Address[]) ?? [];
    const vaultKey = rawSyndicates[i].vault.toLowerCase();
    agentsByVault[vaultKey] = [];
    for (const addr of agentAddresses) {
      const r = agentConfigResults[configIdx++];
      const cfg = r?.status === "success"
        ? (r.result as { agentId: bigint; agentAddress: Address; active: boolean })
        : null;
      if (cfg?.active) {
        const display: AgentDisplay = {
          agentAddress: addr,
          agentId: cfg.agentId.toString(),
          proposalCount: 0,
          totalPnl: "—",
          totalPnlRaw: 0,
        };
        agentsByVault[vaultKey].push(display);
        allAgentIds.push(cfg.agentId);
        agentIdToIndex.push({ vaultKey, idx: agentsByVault[vaultKey].length - 1, agentId: cfg.agentId });
      }
    }
  }

  // Resolve ERC-8004 identities for all agents
  const addresses = getAddresses(chainId);
  if (allAgentIds.length > 0 && addresses.identityRegistry !== ZERO_ADDR) {
    const uniqueIds = [...new Set(allAgentIds)];
    const identities = await resolveAgentIdentities(
      chainId,
      uniqueIds,
      addresses.identityRegistry,
    );
    const nameMap: Record<string, string> = {};
    for (let i = 0; i < uniqueIds.length; i++) {
      if (identities[i]?.name) {
        nameMap[uniqueIds[i].toString()] = identities[i]!.name;
      }
    }
    for (const entry of agentIdToIndex) {
      const name = nameMap[entry.agentId.toString()];
      if (name) {
        agentsByVault[entry.vaultKey][entry.idx].agentName = name;
      }
    }
  }

  // Resolve proposal-aware statuses for all vaults
  const vaultAddresses = rawSyndicates.map((s) => s.vault);
  const proposalStatuses = await resolveProposalStatuses(chainId, vaultAddresses);

  // Build display objects
  return Promise.all(
    rawSyndicates.map(async (s, i) => {
      const totalAssets = (vaultResults[i * 4]?.result as bigint) ?? 0n;
      const agentCount = Number(
        (vaultResults[i * 4 + 1]?.result as bigint) ?? 0n,
      );
      const assetAddr = (vaultResults[i * 4 + 2]?.result as Address) ?? "";
      const info = assetInfo[assetAddr.toLowerCase()] ?? {
        decimals: 18,
        symbol: "ETH",
      };

      const metadata = await fetchMetadata(s.metadataURI);

      const strategy =
        metadata?.strategies?.[0]?.name ||
        metadata?.strategies?.[0]?.protocols?.join(" + ") ||
        "—";

      let status: SyndicateDisplay["status"] = "NO_AGENTS";
      if (agentCount > 0) {
        status = proposalStatuses.get(s.vault.toLowerCase()) ?? "IDLE";
      }

      const tvlFormatted = formatAsset(
        totalAssets,
        info.decimals,
        undefined,
      );

      return {
        id: s.id.toString(),
        vault: s.vault,
        subdomain: s.subdomain,
        name: metadata?.name || `Syndicate #${s.id.toString()}`,
        strategy,
        tvl: `${tvlFormatted} ${info.symbol}`,
        agentCount,
        proposalCount: 0, // not available without extra calls in onchain fallback
        agents: agentsByVault[s.vault.toLowerCase()] ?? [],
        status,
        chainId,
      };
    }),
  );
}

async function fetchSyndicatesForChain(
  chainId: number,
  entry: ChainEntry,
): Promise<SyndicateDisplay[]> {
  // Use subgraph if available, otherwise onchain
  if (entry.subgraphUrl) {
    const results = await fetchViaSubgraph(chainId, entry.subgraphUrl);
    if (results.length > 0) return results;
    // Subgraph returned nothing — fall through to onchain
  }
  return fetchViaOnChain(chainId, entry);
}

// ── Public API ─────────────────────────────────────────────

export async function getActiveSyndicates(): Promise<SyndicateDisplay[]> {
  const results = await Promise.all(
    Object.entries(CHAINS).map(([chainId, entry]) =>
      fetchSyndicatesForChain(Number(chainId), entry),
    ),
  );

  // Flatten and sort newest first (by id descending as proxy for createdAt)
  return results.flat().sort((a, b) => {
    // Try numeric sort first
    const aNum = parseInt(a.id, 10);
    const bNum = parseInt(b.id, 10);
    if (!isNaN(aNum) && !isNaN(bNum)) return bNum - aNum;
    return b.id.localeCompare(a.id);
  });
}
