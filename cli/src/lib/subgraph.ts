/**
 * Subgraph query wrapper for syndicate discovery.
 *
 * Queries The Graph's hosted/studio subgraph for indexed
 * factory + vault events. Much faster than on-chain iteration.
 *
 * Requires SUBGRAPH_URL env var pointing to the subgraph's
 * query endpoint (from The Graph Studio).
 */

export interface SubgraphSyndicate {
  id: string;
  vault: string;
  creator: string;
  metadataURI: string;
  createdAt: string;
  active: boolean;
  totalDeposits: string;
  totalWithdrawals: string;
}

export interface SubgraphAgent {
  id: string;
  pkpAddress: string;
  operatorEOA: string;
  maxPerTx: string;
  dailyLimit: string;
  active: boolean;
  registeredAt: string;
  totalBatches: string;
  totalAssetAmount: string;
}

export interface SubgraphDeposit {
  id: string;
  sender: string;
  owner: string;
  assets: string;
  shares: string;
  timestamp: string;
  txHash: string;
}

export interface SubgraphBatchExecution {
  id: string;
  agent: { id: string; pkpAddress: string };
  callCount: string;
  assetAmount: string;
  timestamp: string;
  txHash: string;
}

export interface SyndicateDetails extends SubgraphSyndicate {
  agents: SubgraphAgent[];
  deposits: SubgraphDeposit[];
  batchExecutions: SubgraphBatchExecution[];
}

function getSubgraphUrl(): string {
  const url = process.env.SUBGRAPH_URL;
  if (!url) {
    throw new Error(
      "SUBGRAPH_URL env var is required. Set it to your The Graph Studio query endpoint.",
    );
  }
  return url;
}

async function query<T>(graphql: string, variables?: Record<string, unknown>): Promise<T> {
  const url = getSubgraphUrl();

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: graphql, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Subgraph query failed (${response.status}): ${text}`);
  }

  const result = (await response.json()) as { data?: T; errors?: { message: string }[] };

  if (result.errors?.length) {
    throw new Error(`Subgraph query error: ${result.errors.map((e) => e.message).join(", ")}`);
  }

  if (!result.data) {
    throw new Error("Subgraph returned no data");
  }

  return result.data;
}

/**
 * Get all active syndicates, optionally filtered by creator.
 */
export async function getActiveSyndicates(
  creator?: string,
): Promise<SubgraphSyndicate[]> {
  const where = creator
    ? `where: { active: true, creator: "${creator.toLowerCase()}" }`
    : `where: { active: true }`;

  const data = await query<{ syndicates: SubgraphSyndicate[] }>(`
    {
      syndicates(${where}, orderBy: createdAt, orderDirection: desc, first: 100) {
        id
        vault
        creator
        metadataURI
        createdAt
        active
        totalDeposits
        totalWithdrawals
      }
    }
  `);

  return data.syndicates;
}

/**
 * Get detailed syndicate info including agents, recent deposits, and batch executions.
 */
export async function getSyndicateDetails(
  syndicateId: string,
): Promise<SyndicateDetails | null> {
  const data = await query<{ syndicate: SyndicateDetails | null }>(`
    {
      syndicate(id: "${syndicateId}") {
        id
        vault
        creator
        metadataURI
        createdAt
        active
        totalDeposits
        totalWithdrawals
        agents(first: 50) {
          id
          pkpAddress
          operatorEOA
          maxPerTx
          dailyLimit
          active
          registeredAt
          totalBatches
          totalAssetAmount
        }
        deposits(first: 10, orderBy: timestamp, orderDirection: desc) {
          id
          sender
          owner
          assets
          shares
          timestamp
          txHash
        }
        batchExecutions(first: 10, orderBy: timestamp, orderDirection: desc) {
          id
          agent {
            id
            pkpAddress
          }
          callCount
          assetAmount
          timestamp
          txHash
        }
      }
    }
  `);

  return data.syndicate;
}

/**
 * Get deposit/withdrawal history for a specific depositor across all syndicates.
 */
export async function getDepositorHistory(
  depositorAddress: string,
): Promise<{ deposits: SubgraphDeposit[]; withdrawals: SubgraphDeposit[] }> {
  const addr = depositorAddress.toLowerCase();

  const data = await query<{
    deposits: SubgraphDeposit[];
    withdrawals: SubgraphDeposit[];
  }>(`
    {
      deposits(where: { owner: "${addr}" }, orderBy: timestamp, orderDirection: desc, first: 50) {
        id
        sender
        owner
        assets
        shares
        timestamp
        txHash
      }
      withdrawals: withdrawals(where: { owner: "${addr}" }, orderBy: timestamp, orderDirection: desc, first: 50) {
        id
        sender
        owner
        assets
        shares
        timestamp
        txHash
      }
    }
  `);

  return { deposits: data.deposits, withdrawals: data.withdrawals };
}
