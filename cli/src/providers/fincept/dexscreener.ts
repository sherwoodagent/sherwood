/**
 * DexScreener data wrapper.
 *
 * Searches DEX pairs and fetches boosted tokens via the Fincept Python
 * bridge (dexscreener_data.py).
 */

import { callFincept } from "./bridge.js";

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export interface FinceptDexPair {
  chainId: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  volume: { h24: number };
  liquidity: { usd: number };
  priceChange: { h24: number };
  txns: { h24: { buys: number; sells: number } };
}

interface DexSearchResponse {
  pairs?: FinceptDexPair[];
}

interface TokenBoost {
  tokenAddress: string;
  chainId: string;
  amount: number;
}

interface DexBoostedResponse {
  data?: Array<Record<string, unknown>>;
}

/**
 * Search DexScreener for trading pairs matching a query.
 *
 * @param query - Search string (token name, symbol, or address)
 * @returns Array of matching pairs, or empty array on failure
 */
export async function searchDexPairs(
  query: string,
): Promise<FinceptDexPair[]> {
  const res = await callFincept<DexSearchResponse>(
    "dexscreener_data.py",
    ["search", query],
    30_000,
    CACHE_TTL,
  );

  if (!res.ok || !res.data?.pairs) return [];
  return res.data.pairs;
}

/**
 * Fetch currently boosted tokens from DexScreener.
 *
 * @returns Array of boosted token entries, or empty array on failure
 */
export async function getTokenBoosts(): Promise<TokenBoost[]> {
  const res = await callFincept<DexBoostedResponse>(
    "dexscreener_data.py",
    ["boosted"],
    30_000,
    CACHE_TTL,
  );

  if (!res.ok || !res.data?.data) return [];

  return res.data.data.map((entry) => ({
    tokenAddress: String(entry.tokenAddress ?? ""),
    chainId: String(entry.chainId ?? ""),
    amount: Number(entry.amount ?? 0),
  }));
}
