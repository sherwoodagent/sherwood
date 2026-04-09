/**
 * DEXScreener free API provider — real-time DEX data across all chains.
 * Base URL: https://api.dexscreener.com/latest
 * No API key needed. Rate limit: 300 req/min.
 */

const BASE_URL = 'https://api.dexscreener.com/latest';

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  priceChange: { h1: number; h6: number; h24: number };
  volume: { h1: number; h6: number; h24: number };
  liquidity: { usd: number };
  fdv: number;
  txns: {
    h1: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
}

interface DexSearchResponse {
  pairs: DexPair[] | null;
}

interface DexPairsResponse {
  pairs: DexPair[] | null;
  pair?: DexPair;
}

// Module-level throttle shared across all instances to enforce rate limit
let sharedLastCallTime = 0;
const SHARED_MIN_INTERVAL = 200; // 200ms = 300 req/min

export class DexScreenerProvider {
  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - sharedLastCallTime;
    if (elapsed < SHARED_MIN_INTERVAL) {
      await new Promise((resolve) => setTimeout(resolve, SHARED_MIN_INTERVAL - elapsed));
    }
    sharedLastCallTime = Date.now();
  }

  private async fetchJson<T>(url: string): Promise<T> {
    await this.throttle();
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`DEXScreener API error: ${res.status} ${res.statusText} — ${url}`);
    }
    return res.json() as Promise<T>;
  }

  /** Search for token pairs by query string (token name, symbol, or address). */
  async searchPairs(query: string): Promise<DexPair[]> {
    const encoded = encodeURIComponent(query);
    const data = await this.fetchJson<DexSearchResponse>(
      `${BASE_URL}/dex/search/?q=${encoded}`,
    );
    return data.pairs ?? [];
  }

  /** Get pair data by chain and pair address. */
  async getPair(chain: string, pairAddress: string): Promise<DexPair> {
    const data = await this.fetchJson<DexPairsResponse>(
      `${BASE_URL}/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(pairAddress)}`,
    );
    if (data.pair) return data.pair;
    if (data.pairs && data.pairs.length > 0) return data.pairs[0]!;
    throw new Error(`No pair found: ${chain}/${pairAddress}`);
  }

  /** Get all DEX pairs for a token address (across all chains). */
  async getTokenPairs(tokenAddress: string): Promise<DexPair[]> {
    const data = await this.fetchJson<DexPairsResponse>(
      `${BASE_URL}/dex/tokens/${encodeURIComponent(tokenAddress)}`,
    );
    return data.pairs ?? [];
  }

  /** Get trending/top pairs by searching for common tokens. */
  async getTrending(): Promise<DexPair[]> {
    // DEXScreener doesn't have a dedicated trending endpoint in the free API,
    // so we search for well-known tokens and sort by volume
    const results = await this.searchPairs('WETH');
    return results
      .filter((p) => p.volume?.h24 > 0)
      .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
      .slice(0, 20);
  }
}
