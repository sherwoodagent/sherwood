/**
 * Server-side syndicate data fetching.
 *
 * Queries the subgraph for active syndicates, then fetches
 * IPFS metadata from Pinata to hydrate names + strategies.
 */

const PINATA_GATEWAY =
  process.env.PINATA_GATEWAY || "https://sherwood.mypinata.cloud";

// ── Subgraph URLs by chain ──────────────────────────────────

const SUBGRAPH_URLS: Record<string, string> = {
  "84532": "https://api.studio.thegraph.com/query/18207/sherwood-sepolia/version/latest",
};

function getSubgraphUrl(): string | undefined {
  // Explicit override always wins
  if (process.env.SUBGRAPH_URL) return process.env.SUBGRAPH_URL;
  const chainId = process.env.CHAIN_ID || "84532"; // default to testnet
  return SUBGRAPH_URLS[chainId];
}

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
  tvl: number;
  agentCount: number;
  status: "EXECUTING" | "IDLE" | "NO_AGENTS";
}

// ── Subgraph ───────────────────────────────────────────────

async function querySubgraph<T>(
  graphql: string
): Promise<T | null> {
  const url = getSubgraphUrl();
  if (!url) return null;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: graphql }),
      next: { revalidate: 60 }, // cache for 60s
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
  ipfsURI: string
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
      next: { revalidate: 300 }, // cache metadata for 5 min
    });

    if (!response.ok) return null;
    return (await response.json()) as SyndicateMetadata;
  } catch {
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────

export async function getActiveSyndicates(): Promise<SyndicateDisplay[]> {
  const data = await querySubgraph<{ syndicates: SubgraphSyndicate[] }>(`
    {
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
    }
  `);

  if (!data?.syndicates?.length) return [];

  // Fetch all metadata in parallel
  const syndicates = await Promise.all(
    data.syndicates.map(async (s) => {
      const metadata = await fetchMetadata(s.metadataURI);

      const totalDeposits = parseFloat(s.totalDeposits) || 0;
      const totalWithdrawals = parseFloat(s.totalWithdrawals) || 0;
      const tvl = totalDeposits - totalWithdrawals;
      const agentCount = s.agents?.length || 0;

      // Derive strategy name from metadata
      const strategy = metadata?.strategies?.[0]?.name
        || (metadata?.strategies?.[0]?.protocols?.join(" + "))
        || "—";

      // Derive status
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
        tvl,
        agentCount,
        status,
      };
    })
  );

  return syndicates;
}
