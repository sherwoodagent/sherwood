/**
 * Messari fundamentals wrapper via Fincept bridge.
 *
 * Provides supply metrics, revenue, and developer activity for tokens.
 */

import { callFincept } from "./bridge.js";

const CACHE_TTL = 60 * 60 * 1_000; // 1 hour

export interface MessariFundamentals {
  marketCap: number;
  supply: {
    circulating: number;
    max: number;
    percentCirculating: number;
  };
  revenueUsd24h: number;
  revenueGrowth7d: number;
  developerActivity: number;
}

/**
 * Map CoinGecko IDs to Messari slugs where they differ.
 * Most IDs are identical — only overrides listed here.
 */
const CG_TO_MESSARI: Record<string, string> = {
  "avalanche-2": "avalanche",
  "worldcoin-wld": "worldcoin",
  "pudgy-penguins": "pudgy-penguins",
  "fetch-ai": "fetch-ai",
};

/** Messari API response shape (subset we care about). */
interface MessariResponse {
  data: {
    id: string;
    metrics: {
      market_data: {
        price_usd: number;
        market_cap: { current_marketcap_usd: number };
      };
      supply: {
        circulating: number;
        max: number;
        y_2050: number;
      };
      blockchain_stats_24_hours: {
        revenue_usd: number;
      };
      developer_activity: {
        commits_last_3_months: number;
      };
    };
  };
}

/**
 * Fetch Messari fundamentals for a token via the Fincept bridge.
 *
 * @param tokenId - CoinGecko token ID (e.g. "ethereum", "avalanche-2")
 * @returns Parsed fundamentals or null if unavailable
 */
export async function getMessariFundamentals(
  tokenId: string,
): Promise<MessariFundamentals | null> {
  const slug = CG_TO_MESSARI[tokenId] ?? tokenId;

  const result = await callFincept<MessariResponse>(
    "messari_data.py",
    ["metrics", slug],
    30_000,
    CACHE_TTL,
  );

  if (!result.ok || !result.data?.data?.metrics) {
    return null;
  }

  const m = result.data.data.metrics;
  const circulating = m.supply?.circulating ?? 0;
  const max = m.supply?.max ?? 0;

  return {
    marketCap: m.market_data?.market_cap?.current_marketcap_usd ?? 0,
    supply: {
      circulating,
      max,
      percentCirculating: max > 0 ? circulating / max : 0,
    },
    revenueUsd24h: m.blockchain_stats_24_hours?.revenue_usd ?? 0,
    revenueGrowth7d: 0, // Messari doesn't expose this directly
    developerActivity: m.developer_activity?.commits_last_3_months ?? 0,
  };
}
