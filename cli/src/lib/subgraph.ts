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
  agentAddress: string;
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

export interface SyndicateDetails extends SubgraphSyndicate {
  agents: SubgraphAgent[];
  deposits: SubgraphDeposit[];
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
  if (creator) {
    const data = await query<{ syndicates: SubgraphSyndicate[] }>(
      `query($creator: String!) {
        syndicates(where: { active: true, creator: $creator }, orderBy: createdAt, orderDirection: desc, first: 100) {
          id
          vault
          creator
          metadataURI
          createdAt
          active
          totalDeposits
          totalWithdrawals
        }
      }`,
      { creator: creator.toLowerCase() },
    );
    return data.syndicates;
  }

  const data = await query<{ syndicates: SubgraphSyndicate[] }>(`
    {
      syndicates(where: { active: true }, orderBy: createdAt, orderDirection: desc, first: 100) {
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
  const data = await query<{ syndicate: SyndicateDetails | null }>(
    `query($id: ID!) {
      syndicate(id: $id) {
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
          agentAddress
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
      }
    }`,
    { id: syndicateId },
  );

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
  }>(
    `query($owner: String!) {
      deposits(where: { owner: $owner }, orderBy: timestamp, orderDirection: desc, first: 50) {
        id
        sender
        owner
        assets
        shares
        timestamp
        txHash
      }
      withdrawals: withdrawals(where: { owner: $owner }, orderBy: timestamp, orderDirection: desc, first: 50) {
        id
        sender
        owner
        assets
        shares
        timestamp
        txHash
      }
    }`,
    { owner: addr },
  );

  return { deposits: data.deposits, withdrawals: data.withdrawals };
}
