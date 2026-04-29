/**
 * Hyperliquid data provider — fetches native exchange data from Hyperliquid's free REST API.
 * Provides funding rates, open interest, order book, and trade flow data.
 * Base URL: https://api.hyperliquid.xyz/info (POST requests, JSON body)
 * Rate limit: reasonable usage, cached for 2 minutes.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HYPERLIQUID_BASE = 'https://api.hyperliquid.xyz/info';

/**
 * Parse a numeric value from the Hyperliquid API safely.
 * Returns `null` if the input is undefined, empty, or would parse to a non-finite
 * value (NaN / Infinity). This prevents silent NaN propagation into scoring,
 * which would otherwise corrupt `NaN * weight = NaN` across the decision stack.
 */
export function safeNumber(x: string | number | undefined | null): number | null {
  if (x === undefined || x === null) return null;
  const n = typeof x === 'number' ? x : parseFloat(x);
  return Number.isFinite(n) ? n : null;
}

/** Key: coin symbol (e.g. "BTC"). Value: last-seen OI + when we saw it. */
interface OiCacheEntry {
  openInterest: number;
  timestamp: number;
}

/** Stale OI entries (> this many ms old) are treated as absent. */
const OI_STALE_MS = 30 * 60 * 1000; // 30 minutes

// Map CoinGecko token IDs to Hyperliquid coin names
const TOKEN_TO_COIN: Record<string, string> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
  arbitrum: 'ARB',
  chainlink: 'LINK',
  aave: 'AAVE',
  uniswap: 'UNI',
  dogecoin: 'DOGE',
  avalanche: 'AVAX',
  'avalanche-2': 'AVAX',
  near: 'NEAR',
  sui: 'SUI',
  aptos: 'APT',
  injective: 'INJ',
  pendle: 'PENDLE',
  pepe: 'PEPE',
  polygon: 'MATIC',
  optimism: 'OP',
  litecoin: 'LTC',
  cosmos: 'ATOM',
  filecoin: 'FIL',
  maker: 'MKR',
  cardano: 'ADA',
  polkadot: 'DOT',
  render: 'RENDER',
  jupiter: 'JUP',
  // Extended for full agent watchlist — all HL perps
  hyperliquid: 'HYPE',
  ethena: 'ENA',
  zcash: 'ZEC',
  ripple: 'XRP',
  bittensor: 'TAO',
  fartcoin: 'FARTCOIN',
  binancecoin: 'BNB',
  blur: 'BLUR',
  'worldcoin-wld': 'WLD',
  'pudgy-penguins': 'PENGU',
  'fetch-ai': 'FET',
};

export interface HyperliquidData {
  fundingRate: number;          // current hourly funding rate (Hyperliquid funds every hour)
  openInterest: number;         // USD value
  oiChangePct: number;          // OI change since last fetch (percentage, NOT 24h)
  volume24h: number;            // 24h notional volume
  markPrice: number;
  oraclePrice: number;
  prevDayPrice: number;
  orderBookImbalance: number;   // (bid_depth - ask_depth) / (bid_depth + ask_depth) for top 10 levels
  largeTradesBias: number;      // net direction of trades > $50K in last hour (-1 to +1)
}

interface MetaAndAssetCtxs {
  universe: Array<{
    name: string;
    szDecimals: number;
  }>;
}

interface AssetCtx {
  funding: string;
  openInterest: string;
  dayNtlVlm: string;
  markPx: string;
  oraclePx: string;
  prevDayPx: string;
}

interface L2BookLevel {
  px: string;
  sz: string;
  n: number;
}

interface L2Book {
  levels: [L2BookLevel[], L2BookLevel[]]; // [bids, asks]
}

interface RecentTrade {
  coin: string;
  side: string;
  px: string;
  sz: string;
  time: number;
  hash: string;
}

export class HyperliquidProvider {
  private cacheDir: string;
  private cacheTTL = 2 * 60 * 1000; // 2 minutes
  private oiCache = new Map<string, OiCacheEntry>(); // persisted; see loadOiCache
  private oiCacheFile: string;
  private oiCacheLoaded = false;
  private oiCacheLoadPromise: Promise<void> | null = null;
  private oiCacheSeq = 0; // per-process monotonically-increasing tmp suffix

  constructor() {
    this.cacheDir = join(homedir(), '.sherwood', 'agent', 'cache');
    this.oiCacheFile = join(this.cacheDir, 'hl-oi.json');
    // Kick off the load eagerly so the first getHyperliquidData call finds it
    // populated. Consumers can also await ensureOiCacheLoaded() directly.
    this.oiCacheLoadPromise = this.loadOiCache();
  }

  /** Load the OI cache from disk. Called once at construction. Never throws. */
  private async loadOiCache(): Promise<void> {
    try {
      const raw = await readFile(this.oiCacheFile, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, OiCacheEntry>;
      if (parsed && typeof parsed === 'object') {
        for (const [coin, entry] of Object.entries(parsed)) {
          if (
            entry
            && Number.isFinite(entry.openInterest)
            && Number.isFinite(entry.timestamp)
          ) {
            this.oiCache.set(coin, entry);
          }
        }
      }
    } catch {
      // No file, corrupt JSON, or permission error — start with an empty cache.
    } finally {
      this.oiCacheLoaded = true;
    }
  }

  private async ensureOiCacheLoaded(): Promise<void> {
    if (this.oiCacheLoaded) return;
    if (this.oiCacheLoadPromise) await this.oiCacheLoadPromise;
  }

  /**
   * Persist the OI cache to disk using an atomic tmp-rename write.
   * Fire-and-forget: callers do NOT await this. Errors are logged as warnings
   * so a slow or full disk never blocks the signal hot path.
   */
  private persistOiCache(): void {
    const snapshot: Record<string, OiCacheEntry> = {};
    for (const [coin, entry] of this.oiCache.entries()) {
      snapshot[coin] = entry;
    }
    // Unique per-process tmp suffix avoids a rename-race between back-to-back
    // persist() calls (writeFile of the second collides with rename of the first).
    const tmp = `${this.oiCacheFile}.tmp.${process.pid}.${++this.oiCacheSeq}`;
    void (async () => {
      try {
        await mkdir(this.cacheDir, { recursive: true });
        await writeFile(tmp, JSON.stringify(snapshot), 'utf-8');
        await rename(tmp, this.oiCacheFile);
      } catch (err) {
        console.warn(`[hyperliquid] oi-cache persist failed: ${(err as Error).message}`);
      }
    })();
  }

  /** Get comprehensive Hyperliquid data for a token. Returns null if token not supported or API failure. */
  async getHyperliquidData(tokenId: string): Promise<HyperliquidData | null> {
    const coin = TOKEN_TO_COIN[tokenId];
    if (!coin) return null;

    // Check cache first
    const cached = await this.readCache(tokenId);
    if (cached) return cached;

    // Make sure the persisted OI cache is available before we compute oiChangePct
    await this.ensureOiCacheLoaded();

    try {
      // Fetch all data in parallel
      const [metaResult, bookResult, tradesResult] = await Promise.allSettled([
        this.fetchMetaAndAssetCtxs(),
        this.fetchL2Book(coin),
        this.fetchRecentTrades(coin)
      ]);

      // Process meta and asset contexts (funding, OI, volume, prices)
      if (metaResult.status !== 'fulfilled' || !metaResult.value) {
        return null;
      }

      const [meta, assetCtxs] = metaResult.value;
      const assetIdx = meta.universe.findIndex(asset => asset.name === coin);
      if (assetIdx === -1 || !assetCtxs[assetIdx]) {
        return null;
      }

      const assetData = assetCtxs[assetIdx]!;
      const fundingRate = safeNumber(assetData.funding);
      const openInterest = safeNumber(assetData.openInterest);
      const volume24h = safeNumber(assetData.dayNtlVlm);
      const markPrice = safeNumber(assetData.markPx);
      const oraclePrice = safeNumber(assetData.oraclePx);
      const prevDayPrice = safeNumber(assetData.prevDayPx);

      // If ANY core field failed to parse, the whole response is tainted —
      // return null rather than let NaN / placeholder zeros reach scoring.
      if (
        fundingRate === null
        || openInterest === null
        || volume24h === null
        || markPrice === null
        || oraclePrice === null
        || prevDayPrice === null
      ) {
        return null;
      }

      // OI change since last fetch. Cache is persisted to disk; entries older
      // than OI_STALE_MS are treated as absent (no false signal from hour-old OI).
      const prior = this.oiCache.get(coin);
      const now = Date.now();
      const priorIsFresh = prior !== undefined && now - prior.timestamp < OI_STALE_MS;
      const prevOI = priorIsFresh ? prior!.openInterest : openInterest;
      const oiChangePct = prevOI > 0 ? ((openInterest - prevOI) / prevOI) * 100 : 0;
      this.oiCache.set(coin, { openInterest, timestamp: now });
      this.persistOiCache(); // fire-and-forget — never awaits disk

      // Process order book imbalance
      let orderBookImbalance = 0;
      if (bookResult.status === 'fulfilled' && bookResult.value) {
        orderBookImbalance = this.calculateOrderBookImbalance(bookResult.value);
      }

      // Process large trades bias
      let largeTradesBias = 0;
      if (tradesResult.status === 'fulfilled' && tradesResult.value) {
        largeTradesBias = this.calculateLargeTradesBias(tradesResult.value);
      }

      const data: HyperliquidData = {
        fundingRate,
        openInterest,
        oiChangePct,
        volume24h,
        markPrice,
        oraclePrice,
        prevDayPrice,
        orderBookImbalance,
        largeTradesBias,
      };

      // Cache results
      await this.writeCache(tokenId, data);

      return data;
    } catch (err) {
      console.error(`Hyperliquid API error for ${tokenId}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Fetch metadata and asset contexts (funding, OI, volume, prices). */
  private async fetchMetaAndAssetCtxs(): Promise<[MetaAndAssetCtxs, AssetCtx[]] | null> {
    const response = await fetch(HYPERLIQUID_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });

    if (!response.ok) return null;
    const data = await response.json() as [MetaAndAssetCtxs, AssetCtx[]];
    return data;
  }

  /** Fetch L2 order book for a coin. */
  private async fetchL2Book(coin: string): Promise<L2Book | null> {
    const response = await fetch(HYPERLIQUID_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'l2Book', coin }),
    });

    if (!response.ok) return null;
    return await response.json() as L2Book;
  }

  /**
   * Fetch OHLCV candles from Hyperliquid. Free, no rate limit, real-time.
   * Replaces CoinGecko OHLC as the primary candle source so the technical
   * signal stack doesn't go blind when CG's free tier 429s.
   *
   * @param tokenId CoinGecko token ID (resolved via TOKEN_TO_COIN)
   * @param interval  HL interval string: '1h', '4h', '1d'
   * @param lookbackMs  How far back to fetch (default 30 days)
   * @returns Array of Candle objects, or null if the token isn't mapped
   */
  async getCandles(
    tokenId: string,
    interval: '1h' | '4h' | '1d' = '4h',
    lookbackMs: number = 30 * 24 * 60 * 60 * 1000,
  ): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null> {
    const coin = TOKEN_TO_COIN[tokenId];
    if (!coin) return null;

    try {
      const now = Date.now();
      const response = await fetch(HYPERLIQUID_BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'candleSnapshot',
          req: { coin, interval, startTime: now - lookbackMs, endTime: now },
        }),
      });

      if (!response.ok) return null;

      const raw = await response.json() as Array<{
        t: number; T: number; s: string; i: string;
        o: string; c: string; h: string; l: string; v: string; n: number;
      }>;

      if (!Array.isArray(raw) || raw.length === 0) return null;

      return raw.map(c => {
        const o = safeNumber(c.o);
        const h = safeNumber(c.h);
        const l = safeNumber(c.l);
        const close = safeNumber(c.c);
        const v = safeNumber(c.v);
        if (o === null || h === null || l === null || close === null) return null;
        return { timestamp: c.t, open: o, high: h, low: l, close, volume: v ?? 0 };
      }).filter((c): c is NonNullable<typeof c> => c !== null);
    } catch {
      return null;
    }
  }

  /** Fetch recent trades for a coin. */
  private async fetchRecentTrades(coin: string): Promise<RecentTrade[] | null> {
    const response = await fetch(HYPERLIQUID_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'recentTrades', coin }),
    });

    if (!response.ok) return null;
    return await response.json() as RecentTrade[];
  }

  /** Calculate order book imbalance from L2 book. */
  private calculateOrderBookImbalance(book: L2Book): number {
    const [bids, asks] = book.levels;

    // Sum top 10 levels for both sides. Skip any level whose size fails to parse
    // rather than letting NaN infect the depth total.
    const sumDepth = (levels: L2BookLevel[]): number =>
      levels.slice(0, 10).reduce((sum, level) => {
        const sz = safeNumber(level.sz);
        return sz === null ? sum : sum + sz;
      }, 0);

    const bidDepth = sumDepth(bids);
    const askDepth = sumDepth(asks);

    const totalDepth = bidDepth + askDepth;
    if (totalDepth === 0) return 0;

    return (bidDepth - askDepth) / totalDepth;
  }

  /** Calculate large trades bias from recent trades (>$50K in last hour). */
  private calculateLargeTradesBias(trades: RecentTrade[]): number {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const recentTrades = trades.filter(t => t.time > oneHourAgo);

    let buyVolume = 0;
    let sellVolume = 0;

    for (const trade of recentTrades) {
      const size = safeNumber(trade.sz);
      const price = safeNumber(trade.px);
      if (size === null || price === null) continue; // drop unparseable trades
      const notional = size * price;

      // Only count trades >$50K
      if (notional > 50000) {
        if (trade.side === 'B') {
          buyVolume += notional;
        } else if (trade.side === 'A') {
          sellVolume += notional;
        }
      }
    }

    const totalVolume = buyVolume + sellVolume;
    if (totalVolume === 0) return 0;

    return (buyVolume - sellVolume) / totalVolume;
  }

  /** Read cached Hyperliquid data. */
  private async readCache(tokenId: string): Promise<HyperliquidData | null> {
    try {
      const cacheFile = join(this.cacheDir, `hl-${tokenId}.json`);
      const raw = await readFile(cacheFile, 'utf-8');
      const cached = JSON.parse(raw) as { ts: number; data: HyperliquidData };

      if (Date.now() - cached.ts < this.cacheTTL) {
        return cached.data;
      }
    } catch {
      // No cache or invalid cache
    }
    return null;
  }

  /** Write Hyperliquid data to cache. */
  private async writeCache(tokenId: string, data: HyperliquidData): Promise<void> {
    try {
      await mkdir(this.cacheDir, { recursive: true });
      const cacheFile = join(this.cacheDir, `hl-${tokenId}.json`);
      await writeFile(cacheFile, JSON.stringify({ ts: Date.now(), data }), 'utf-8');
    } catch {
      // Cache write failure is non-fatal
    }
  }
}