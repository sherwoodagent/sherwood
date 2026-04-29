/**
 * DefiLlama data wrapper.
 *
 * Fetches protocol TVL and yield pool data via the Fincept Python bridge
 * (defillama_data.py).
 */

import { callFincept } from "./bridge.js";

const TVL_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

interface DefiLlamaTvlResponse {
  tvl?: number;
  name?: string;
  [key: string]: unknown;
}

interface DefiLlamaYieldsResponse {
  data?: Array<Record<string, unknown>>;
}

export interface YieldPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
}

/**
 * Fetch protocol TVL from DefiLlama.
 *
 * @param tokenId - CoinGecko-style token ID (e.g. "aave", "uniswap")
 * @returns TVL in USD, or null on failure
 */
export async function getProtocolTvl(
  tokenId: string,
): Promise<number | null> {
  const res = await callFincept<DefiLlamaTvlResponse>(
    "defillama_data.py",
    ["protocol", tokenId],
    30_000,
    TVL_CACHE_TTL,
  );

  if (!res.ok || !res.data) return null;
  return res.data.tvl ?? null;
}

/**
 * Fetch top yield pools from DefiLlama.
 *
 * @param limit - Maximum number of pools to return (default 20)
 * @returns Array of yield pool entries, or null on failure
 */
export async function getYieldPools(
  limit: number = 20,
): Promise<YieldPool[] | null> {
  const res = await callFincept<DefiLlamaYieldsResponse>(
    "defillama_data.py",
    ["yields"],
    30_000,
    60 * 60 * 1000, // 1 hour cache
  );

  if (!res.ok || !res.data?.data) return null;

  return res.data.data
    .slice(0, limit)
    .map((entry) => ({
      pool: String(entry.pool ?? ""),
      chain: String(entry.chain ?? ""),
      project: String(entry.project ?? ""),
      symbol: String(entry.symbol ?? ""),
      tvlUsd: Number(entry.tvlUsd ?? 0),
      apy: Number(entry.apy ?? 0),
    }));
}
