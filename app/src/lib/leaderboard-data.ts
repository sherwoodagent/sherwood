/**
 * Shared leaderboard-ranking helper.
 *
 * Used by both the leaderboard page (SSR) and the /api/leaderboard
 * route handler (client-side auto-refresh in LeaderboardTabs).
 */

import { getActiveSyndicates, type SyndicateDisplay } from "./syndicates";

export interface RankedSyndicate extends SyndicateDisplay {
  tvlNum: number;
  tvlUSDDisplay: string;
}

const USD_STABLES = new Set(["USDC", "USDT", "DAI", "USDbC"]);

const SYMBOL_TO_COINGECKO: Record<string, string> = {
  WETH: "ethereum",
  ETH: "ethereum",
  wstETH: "wrapped-steth",
  cbETH: "coinbase-wrapped-staked-eth",
  WBTC: "wrapped-bitcoin",
  rETH: "rocket-pool-eth",
};

type TokenPrices = Record<string, number>;

export async function fetchTokenPrices(): Promise<TokenPrices> {
  const ids = [...new Set(Object.values(SYMBOL_TO_COINGECKO))].join(",");
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`,
      { next: { revalidate: 300 } },
    );
    if (!res.ok) {
      console.warn(
        `[leaderboard] CoinGecko returned ${res.status} — non-stablecoin TVL will show as $0`,
      );
      return {};
    }
    const data = await res.json();
    const prices: TokenPrices = {};
    for (const [id, val] of Object.entries(data)) {
      prices[id] = (val as { usd: number }).usd;
    }
    return prices;
  } catch (err) {
    console.warn(
      "[leaderboard] CoinGecko fetch failed — non-stablecoin TVL will show as $0",
      err,
    );
    return {};
  }
}

function getUSDPrice(symbol: string, tokenPrices: TokenPrices): number {
  if (USD_STABLES.has(symbol)) return 1;
  const geckoId = SYMBOL_TO_COINGECKO[symbol];
  if (geckoId && tokenPrices[geckoId] !== undefined) return tokenPrices[geckoId];
  return 0;
}

function parseTVL(tvl: string): number {
  const cleaned = tvl.replace(/[^0-9.]/g, "");
  return parseFloat(cleaned) || 0;
}

function parseAssetSymbol(tvl: string): string {
  const parts = tvl.trim().split(/\s+/);
  return parts.length >= 2 ? parts[parts.length - 1] : "USDC";
}

function formatUSD(num: number): string {
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

export function formatTotalTVL(
  tvlStrings: string[],
  tokenPrices: TokenPrices,
): string {
  let totalUSD = 0;
  for (const tvl of tvlStrings) {
    const symbol = parseAssetSymbol(tvl);
    const amount = parseTVL(tvl);
    totalUSD += amount * getUSDPrice(symbol, tokenPrices);
  }
  return formatUSD(totalUSD);
}

/**
 * Fetch, rank (by USD TVL), and format the syndicates for leaderboard
 * display. Cheap enough to call from a route handler.
 */
export async function getRankedSyndicates(): Promise<{
  ranked: RankedSyndicate[];
  tokenPrices: TokenPrices;
}> {
  const [syndicates, tokenPrices] = await Promise.all([
    getActiveSyndicates(),
    fetchTokenPrices(),
  ]);

  const ranked: RankedSyndicate[] = [...syndicates]
    .map((s) => {
      const amount = parseTVL(s.tvl);
      const symbol = parseAssetSymbol(s.tvl);
      const tvlUSD = amount * getUSDPrice(symbol, tokenPrices);
      return { ...s, tvlNum: tvlUSD, tvlUSDDisplay: formatUSD(tvlUSD) };
    })
    .sort((a, b) => b.tvlNum - a.tvlNum);

  return { ranked, tokenPrices };
}
