/**
 * CoinGecko free API provider with aggressive caching and rate-limiting.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Provider, ProviderInfo } from "../../types.js";

const BASE_URL = "https://api.coingecko.com/api/v3";

// Shared mutex queue across all instances to prevent 429s.
// Each request chains onto this promise so only one runs at a time with a 2.5s gap.
let requestQueue: Promise<void> = Promise.resolve();
let sharedLastCallTime = 0;
let MIN_INTERVAL = 2500; // 2.5s between calls (CG free tier: 30/min = 1 every 2s)

// Cache TTLs by endpoint (in milliseconds)
const CACHE_TTLS = {
  ohlc: 2 * 60 * 60 * 1000,        // 2 hours - historical candles don't change
  market_chart: 60 * 60 * 1000,    // 1 hour
  coin_details: 60 * 60 * 1000,    // 1 hour
  simple_price: 5 * 60 * 1000,     // 5 minutes
  trending: 30 * 60 * 1000,        // 30 minutes
} as const;

export class CoinGeckoProvider implements Provider {
  private cacheDir: string;
  private apiKey?: string;

  constructor() {
    this.cacheDir = join(homedir(), '.sherwood', 'agent', 'cache', 'coingecko');
    // Check for API key from env or config
    this.apiKey = process.env.COINGECKO_API_KEY;

    // Adjust throttle for demo key
    if (this.apiKey) {
      MIN_INTERVAL = 1500; // Demo key has better limits
    }
  }

  info(): ProviderInfo {
    return {
      name: "CoinGecko",
      type: "research",
      capabilities: ["price", "market-data", "ohlc", "coin-details", "trending"],
      supportedChains: [],
    };
  }

  /**
   * Generate cache key from endpoint and params.
   */
  private getCacheKey(endpoint: string, params: string): string {
    const hash = createHash('sha1').update(params).digest('hex').substring(0, 8);
    return `${endpoint}-${hash}.json`;
  }

  /**
   * Get cache TTL for an endpoint.
   */
  private getCacheTTL(url: string): number {
    if (url.includes('/ohlc')) return CACHE_TTLS.ohlc;
    if (url.includes('/market_chart')) return CACHE_TTLS.market_chart;
    if (url.includes('/coins/') && !url.includes('/market_chart')) return CACHE_TTLS.coin_details;
    if (url.includes('/simple/price')) return CACHE_TTLS.simple_price;
    if (url.includes('/trending')) return CACHE_TTLS.trending;
    return CACHE_TTLS.simple_price; // Default fallback
  }

  /**
   * Read from cache if available and fresh.
   */
  private async readCache(cacheKey: string, ttl: number): Promise<any | null> {
    try {
      const cacheFile = join(this.cacheDir, cacheKey);
      const raw = await readFile(cacheFile, 'utf-8');
      const cached = JSON.parse(raw) as { ts: number; data: any };

      if (Date.now() - cached.ts < ttl) {
        return cached.data;
      }
    } catch {
      // Cache miss or invalid cache
    }
    return null;
  }

  /**
   * Write to cache with atomic write (tmp file + rename).
   */
  private async writeCache(cacheKey: string, data: any): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const cacheFile = join(this.cacheDir, cacheKey);
      const tmpFile = cacheFile + '.tmp';

      await writeFile(tmpFile, JSON.stringify({ ts: Date.now(), data }), 'utf-8');
      // Atomic rename (requires fs.rename which we'll use from import)
      await import('node:fs/promises').then(fs => fs.rename(tmpFile, cacheFile));
    } catch {
      // Cache write failure is non-fatal
    }
  }

  /**
   * Serialised request method — every CoinGecko call goes through here.
   * Checks cache first, then uses shared promise chain for API calls.
   */
  private async fetchJson(url: string): Promise<any> {
    // Extract cache key from URL
    const urlObj = new URL(url);
    const endpoint = urlObj.pathname.split('/').pop() || 'unknown';
    const params = urlObj.search;
    const cacheKey = this.getCacheKey(endpoint, params);
    const ttl = this.getCacheTTL(url);

    // Check cache first — if hit, return immediately without touching rate limiter
    const cached = await this.readCache(cacheKey, ttl);
    if (cached) {
      return cached;
    }

    // Cache miss — make API call with rate limiting
    const job = requestQueue.then(async () => {
      const now = Date.now();
      const elapsed = now - sharedLastCallTime;
      if (elapsed < MIN_INTERVAL) {
        await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL - elapsed));
      }
      sharedLastCallTime = Date.now();

      // Add API key header if available
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['x-cg-demo-api-key'] = this.apiKey;
      }

      const res = await fetch(url, { headers });
      if (res.status === 429) {
        // Rate limited — exponential backoff: 10s, 30s, 60s
        let retryDelay = 10_000;
        for (let attempt = 0; attempt < 3; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          sharedLastCallTime = Date.now();

          const retry = await fetch(url, { headers });
          if (retry.ok) {
            const data = await retry.json();
            await this.writeCache(cacheKey, data);
            return data;
          }

          retryDelay *= 3; // 10s -> 30s -> 90s (but we cap at 60s)
          if (retryDelay > 60_000) retryDelay = 60_000;
        }
        throw new Error(`CoinGecko rate limit exceeded after retries — ${url}`);
      }
      if (!res.ok) throw new Error(`CoinGecko error: ${res.status} ${res.statusText} — ${url}`);

      const data = await res.json();
      await this.writeCache(cacheKey, data);
      return data;
    });

    // Chain the next request after this one settles (success or failure)
    requestQueue = job.then(() => {}, () => {});
    return job;
  }

  /**
   * Get simple prices for multiple tokens.
   * Returns price, 24h vol, 24h change, and market cap per token.
   */
  async getPrice(
    ids: string[],
    vsCurrencies: string[] = ["usd"],
  ): Promise<Record<string, any>> {
    const params = new URLSearchParams({
      ids: ids.join(","),
      vs_currencies: vsCurrencies.join(","),
      include_24hr_vol: "true",
      include_24hr_change: "true",
      include_market_cap: "true",
    });
    return this.fetchJson(`${BASE_URL}/simple/price?${params}`);
  }

  /**
   * Get market chart data (prices, market_caps, total_volumes) over time.
   * Note: only fetches for a single id at a time.
   */
  async getMarketData(
    id: string,
    days: number = 30,
  ): Promise<{ prices: number[][]; market_caps: number[][]; total_volumes: number[][] }> {
    const params = new URLSearchParams({
      vs_currency: "usd",
      days: String(days),
    });
    return this.fetchJson(`${BASE_URL}/coins/${encodeURIComponent(id)}/market_chart?${params}`);
  }

  /**
   * Get OHLC candle data.
   * days: 1/7/14/30/90/180/365/max
   * Returns array of [timestamp, open, high, low, close].
   */
  async getOHLC(
    id: string,
    days: number = 30,
  ): Promise<number[][]> {
    const params = new URLSearchParams({
      vs_currency: "usd",
      days: String(days),
    });
    return this.fetchJson(`${BASE_URL}/coins/${encodeURIComponent(id)}/ohlc?${params}`);
  }

  /** Get detailed coin information. */
  async getCoinDetails(id: string): Promise<any> {
    const params = new URLSearchParams({
      localization: "false",
      tickers: "false",
      community_data: "true",
      developer_data: "true",
    });
    return this.fetchJson(`${BASE_URL}/coins/${encodeURIComponent(id)}?${params}`);
  }

  /** Get trending coins. */
  async getTrending(): Promise<any> {
    return this.fetchJson(`${BASE_URL}/search/trending`);
  }
}
