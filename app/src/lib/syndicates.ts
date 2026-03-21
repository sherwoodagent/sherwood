/**
 * Server-side syndicate data fetching.
 *
 * Multichain — fetches syndicates from ALL chains in CHAINS simultaneously.
 * Uses subgraph where available, falls back to on-chain factory.getActiveSyndicates().
 */

import { type Address } from "viem";
import {
  CHAINS,
  type ChainEntry,
  getPublicClient,
  SYNDICATE_FACTORY_ABI,
  SYNDICATE_VAULT_ABI,
  ERC20_ABI,
  formatAsset,
} from "./contracts";

const PINATA_GATEWAY =
  process.env.PINATA_GATEWAY || "https://sherwood.mypinata.cloud";

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
  agents: { id: string; active: boolean }[];
}

interface SyndicateMetadata {
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
  };
}

export interface SyndicateDisplay {
  id: string;
  vault: string;
  subdomain: string;
  name: string;
  strategy: string;
  tvl: string;
  agentCount: number;
  status: "EXECUTING" | "IDLE" | "NO_AGENTS";
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

// ── IPFS Metadata ──────────────────────────────────────────

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
          active
        }
      }
    }`,
  );

  if (!data?.syndicates?.length) return [];

  return Promise.all(
    data.syndicates.map(async (s) => {
      const metadata = await fetchMetadata(s.metadataURI);

      const totalDeposits = parseFloat(s.totalDeposits) || 0;
      const totalWithdrawals = parseFloat(s.totalWithdrawals) || 0;
      const tvl = totalDeposits - totalWithdrawals;
      const agentCount = s.agents?.length || 0;

      const strategy =
        metadata?.strategies?.[0]?.name ||
        metadata?.strategies?.[0]?.protocols?.join(" + ") ||
        "—";

      let status: SyndicateDisplay["status"] = "NO_AGENTS";
      if (agentCount > 0) {
        status = tvl > 0 ? "EXECUTING" : "IDLE";
      }

      return {
        id: s.id,
        vault: s.vault,
        subdomain: s.subdomain,
        name: metadata?.name || `Syndicate #${s.id}`,
        strategy,
        tvl: `$${tvl.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
        agentCount,
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

  // For each syndicate, multicall vault data: totalAssets, getAgentCount, asset
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
  ]);

  const vaultResults = await client.multicall({ contracts: vaultCalls });

  // Collect unique asset addresses for decimals + symbol lookup
  const assetAddresses = new Set<Address>();
  for (let i = 0; i < rawSyndicates.length; i++) {
    const assetResult = vaultResults[i * 3 + 2];
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

  // Build display objects
  return Promise.all(
    rawSyndicates.map(async (s, i) => {
      const totalAssets = (vaultResults[i * 3]?.result as bigint) ?? 0n;
      const agentCount = Number(
        (vaultResults[i * 3 + 1]?.result as bigint) ?? 0n,
      );
      const assetAddr = (vaultResults[i * 3 + 2]?.result as Address) ?? "";
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
        status = totalAssets > 0n ? "EXECUTING" : "IDLE";
      }

      const tvlFormatted = formatAsset(
        totalAssets,
        info.decimals,
        info.symbol === "USDC" ? "USD" : undefined,
      );

      return {
        id: s.id.toString(),
        vault: s.vault,
        subdomain: s.subdomain,
        name: metadata?.name || `Syndicate #${s.id.toString()}`,
        strategy,
        tvl: info.symbol === "USDC" ? tvlFormatted : `${tvlFormatted} ${info.symbol}`,
        agentCount,
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
  // Use subgraph if available, otherwise on-chain
  if (entry.subgraphUrl) {
    const results = await fetchViaSubgraph(chainId, entry.subgraphUrl);
    if (results.length > 0) return results;
    // Subgraph returned nothing — fall through to on-chain
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
