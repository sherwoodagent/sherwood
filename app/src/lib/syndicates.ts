/**
 * Server-side syndicate data fetching.
 *
 * Multichain — fetches syndicates from ALL chains in CHAINS simultaneously.
 * Uses subgraph where available, falls back to onchain factory.getActiveSyndicates().
 */

import { formatUnits, type Address } from "viem";
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
import {
  fetchMetadata,
  resolveAgentIdentities,
  fetchEquityCurve,
} from "./syndicate-data";

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
  tvlRaw: number;
  assetSymbol: string;
  agentCount: number;
  agents: AgentDisplay[];
  proposalCount: number;
  status: "ACTIVE_STRATEGY" | "VOTING" | "IDLE" | "NO_AGENTS";
  chainId: number;
  /** Cumulative net flow direction. +1 deposits-positive, -1 withdrawals-dominant, 0 unknown. */
  flowTrend?: -1 | 0 | 1;
  /** Days since the syndicate was created. Used for the "NEW" badge. */
  ageDays?: number;
  /** 7-day TVL series for the leaderboard sparkline (see fetchEquityCurve). */
  equityCurve?: number[];
}

/**
 * Honest rank-supplemental signals from cheap subgraph fields.
 * Kept lightweight on purpose — a real per-syndicate equity series would
 * require N extra queries per leaderboard load.
 */
function computeFlowTrend(deposits: string, withdrawals: string): -1 | 0 | 1 {
  try {
    const d = BigInt(deposits || "0");
    const w = BigInt(withdrawals || "0");
    if (d === 0n && w === 0n) return 0;
    if (w === 0n) return 1;
    // Trend up if deposits > 1.1x withdrawals, down if reversed
    if (d * 10n > w * 11n) return 1;
    if (w * 10n > d * 11n) return -1;
    return 0;
  } catch {
    return 0;
  }
}

function computeAgeDays(createdAt: string): number {
  try {
    const ts = Number(createdAt);
    if (!ts) return 0;
    return Math.max(0, Math.floor((Date.now() / 1000 - ts) / 86400));
  } catch {
    return 0;
  }
}

/** Compute aggregate protocol stats from a list of syndicates. */
export function computeProtocolStats(syndicates: SyndicateDisplay[]) {
  const totalAgents = syndicates.reduce((sum, s) => sum + s.agentCount, 0);
  const totalProposals = syndicates.reduce((sum, s) => sum + s.proposalCount, 0);
  // Sum TVL — only USD-denominated assets (USDC/USDT) for now
  const totalTVL = syndicates.reduce((sum, s) => {
    if (s.assetSymbol === "USDC" || s.assetSymbol === "USDT") return sum + s.tvlRaw;
    return sum;
  }, 0);
  const fractionDigits = totalTVL < 1000 ? 2 : 0;
  const totalTVLFormatted = totalTVL.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  return {
    syndicateCount: syndicates.length,
    totalAgents,
    totalProposals,
    totalTVL: totalTVLFormatted,
  };
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
interface ProposalStatusResult {
  statuses: Map<string, "VOTING" | "ACTIVE_STRATEGY">;
  /** vault address (lowercase) → capital-snapshot bigint for vaults with an
   *  executing proposal. Used to render TVL that INCLUDES deployed capital. */
  capitalSnapshots: Map<string, bigint>;
}

async function resolveProposalStatuses(
  chainId: number,
  vaults: Address[],
): Promise<ProposalStatusResult> {
  const statusMap = new Map<string, "VOTING" | "ACTIVE_STRATEGY">();
  const capitalSnapshots = new Map<string, bigint>();
  if (vaults.length === 0) return { statuses: statusMap, capitalSnapshots };

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
  if (govVaults.length === 0) return { statuses: statusMap, capitalSnapshots };

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

  // Mark vaults with an executed active proposal + collect proposal IDs so
  // we can batch-read their capitalSnapshots in the next multicall.
  const vaultSet = new Set(govVaults.map((gv) => gv.vault.toLowerCase()));
  const activeByVault: { vault: Address; proposalId: bigint }[] = [];
  for (let i = 0; i < govVaults.length; i++) {
    const r = activeResults[i];
    if (r.status === "success") {
      const pid = r.result as bigint;
      if (pid > 0n) {
        statusMap.set(govVaults[i].vault.toLowerCase(), "ACTIVE_STRATEGY");
        activeByVault.push({ vault: govVaults[i].vault, proposalId: pid });
      }
    }
  }

  // Batch read capitalSnapshot for every active proposal so leaderboard TVL
  // reflects capital that's out in strategies, not just the vault balance.
  if (activeByVault.length > 0) {
    const snapshotResults = await client.multicall({
      contracts: activeByVault.map((av) => ({
        address: governorAddress,
        abi: SYNDICATE_GOVERNOR_ABI,
        functionName: "getCapitalSnapshot" as const,
        args: [av.proposalId] as const,
      })),
    });
    for (let i = 0; i < activeByVault.length; i++) {
      const r = snapshotResults[i];
      if (r.status === "success") {
        capitalSnapshots.set(
          activeByVault[i].vault.toLowerCase(),
          r.result as bigint,
        );
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

  return { statuses: statusMap, capitalSnapshots };
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
  const { statuses: proposalStatuses, capitalSnapshots } =
    await resolveProposalStatuses(chainId, vaultAddresses);

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
      const rawTotalAssets = (vaultResults[i * 2]?.result as bigint) ?? 0n;
      const assetAddr = (vaultResults[i * 2 + 1]?.result as Address) ?? "";
      const info = assetInfo[assetAddr.toLowerCase()] ?? {
        decimals: 18,
        symbol: "ETH",
      };

      // TVL / equity-curve snapshot uses the same bias as above (prefer
      // the proposal's capitalSnapshot when the vault is mid-strategy).
      const snapshotPeek = capitalSnapshots.get(s.vault.toLowerCase());
      const totalAssetsForCurve =
        snapshotPeek && snapshotPeek > rawTotalAssets
          ? snapshotPeek
          : rawTotalAssets;

      const [metadata, equityCurve] = await Promise.all([
        fetchMetadata(s.metadataURI),
        fetchEquityCurve(
          subgraphUrl,
          s.id,
          info.decimals,
          totalAssetsForCurve,
        ),
      ]);

      const agentCount = s.agents?.length || 0;

      const strategy =
        metadata?.strategies?.[0]?.name ||
        metadata?.strategies?.[0]?.protocols?.join(" + ") ||
        "—";

      let status: SyndicateDisplay["status"] = "NO_AGENTS";
      if (agentCount > 0) {
        status = proposalStatuses.get(s.vault.toLowerCase()) ?? "IDLE";
      }

      // During an active strategy the vault's totalAssets is drained (capital
      // sits in the strategy contract). Fall back to the proposal's
      // capitalSnapshot so the leaderboard TVL reflects full AUM.
      const totalAssets = totalAssetsForCurve;

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
        tvlRaw: parseFloat(formatUnits(totalAssets, info.decimals)),
        assetSymbol: info.symbol,
        agentCount,
        proposalCount: (s.proposals || []).length,
        flowTrend: computeFlowTrend(s.totalDeposits, s.totalWithdrawals),
        ageDays: computeAgeDays(s.createdAt),
        equityCurve,
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
            totalPnlRaw: parseFloat(formatUnits(stats.pnl < 0n ? -stats.pnl : stats.pnl, info.decimals)) * (stats.pnl < 0n ? -1 : 1),
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
  const { statuses: proposalStatuses, capitalSnapshots } =
    await resolveProposalStatuses(chainId, vaultAddresses);

  // Build display objects
  return Promise.all(
    rawSyndicates.map(async (s, i) => {
      const rawTotalAssets = (vaultResults[i * 4]?.result as bigint) ?? 0n;
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

      // Include deployed capital in TVL when the strategy is active.
      const snapshot = capitalSnapshots.get(s.vault.toLowerCase());
      const totalAssets =
        snapshot && snapshot > rawTotalAssets ? snapshot : rawTotalAssets;

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
        tvlRaw: parseFloat(formatUnits(totalAssets, info.decimals)),
        assetSymbol: info.symbol,
        agentCount,
        proposalCount: 0, // not available without extra calls in onchain fallback
        // equityCurve intentionally omitted: it's reconstructed from
        // subgraph event history in fetchViaSubgraph, and this code path
        // runs only when that subgraph is unreachable. Rows coming from
        // this fallback render "—" in the Trend (7D) column, which is
        // the correct graceful degradation.
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
