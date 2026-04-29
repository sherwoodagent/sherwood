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

// Circuit breaker: when we observe a 429, freeze all CG requests for this window.
// Previous behavior retried 10s → 30s → 60s per call; because the queue is global
// serial, a single rate-limit window ballooned one cycle from ~60s to ~15 min
// (18 tokens × up to 100s per 429). Now we fail fast, let callers use cache/null,
// and resume after the window. Break resets once a successful call lands.
const CIRCUIT_BREAK_MS = 5 * 60 * 1000; // 5 minutes
let circuitOpenUntil = 0;

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
    const hash = createHash('sha1').update(endpoint + params).digest('hex').substring(0, 12);
    return `${hash}.json`;
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
    // Extract cache key from full URL path (includes token ID)
    const urlObj = new URL(url);
    const cacheKey = this.getCacheKey(urlObj.pathname, urlObj.search);
    const ttl = this.getCacheTTL(url);

    // Check cache first — if hit, return immediately without touching rate limiter
    const cached = await this.readCache(cacheKey, ttl);
    if (cached) {
      return cached;
    }

    // Circuit breaker: if a recent 429 tripped the breaker, fail fast instead of
    // queueing up more doomed calls. A cycle scanning 18 tokens was observed to
    // take 14-18 minutes during rate-limit windows because every serialized call
    // exhausted its 10s/30s/60s retry budget. Fail-fast lets each call burn
    // ~0ms instead of ~100s and returns control to the caller immediately.
    if (Date.now() < circuitOpenUntil) {
      throw new Error(`CoinGecko circuit breaker open — rate-limited, retrying after ${new Date(circuitOpenUntil).toISOString()}`);
    }

    // Cache miss — make API call with rate limiting
    const job = requestQueue.then(async () => {
      // Re-check breaker inside the serialized job: callers that queued behind
      // the 429-triggering call should also fail fast rather than replay 10-60s
      // backoffs one-by-one.
      if (Date.now() < circuitOpenUntil) {
        throw new Error(`CoinGecko circuit breaker open — rate-limited, retrying after ${new Date(circuitOpenUntil).toISOString()}`);
      }

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
        // Rate limited — trip the circuit breaker and fail fast. Do NOT retry
        // inline: the 10s/30s/60s per-call backoff made cycles balloon to
        // 15+ minutes when CG was cranky. Caller gets a clean failure, can
        // fall back to cached/null, and subsequent CG calls in this cycle
        // skip the API entirely until the window closes.
        circuitOpenUntil = Date.now() + CIRCUIT_BREAK_MS;
        throw new Error(`CoinGecko 429 — circuit breaker opened for ${CIRCUIT_BREAK_MS / 1000}s — ${url}`);
      }
      if (!res.ok) throw new Error(`CoinGecko error: ${res.status} ${res.statusText} — ${url}`);

      const data = await res.json();
      // Success closes the breaker (we got through, so the rate window passed).
      circuitOpenUntil = 0;
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
