/**
 * Hyperliquid data provider — fetches native exchange data from Hyperliquid's free REST API.
 * Provides funding rates, open interest, order book, and trade flow data.
 * Base URL: https://api.hyperliquid.xyz/info (POST requests, JSON body)
 * Rate limit: reasonable usage, cached for 2 minutes.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HYPERLIQUID_BASE = 'https://api.hyperliquid.xyz/info';

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
  private oiCache = new Map<string, number>(); // For tracking OI changes

  constructor() {
    this.cacheDir = join(homedir(), '.sherwood', 'agent', 'cache');
  }

  /** Get comprehensive Hyperliquid data for a token. Returns null if token not supported or API failure. */
  async getHyperliquidData(tokenId: string): Promise<HyperliquidData | null> {
    const coin = TOKEN_TO_COIN[tokenId];
    if (!coin) return null;

    // Check cache first
    const cached = await this.readCache(tokenId);
    if (cached) return cached;

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
      const fundingRate = parseFloat(assetData.funding);
      const openInterest = parseFloat(assetData.openInterest);
      const volume24h = parseFloat(assetData.dayNtlVlm);
      const markPrice = parseFloat(assetData.markPx);
      const oraclePrice = parseFloat(assetData.oraclePx);
      const prevDayPrice = parseFloat(assetData.prevDayPx);

      // OI change since last fetch (NOT 24h — in-memory cache resets on restart).
      // For true 24h change, would need historical snapshots on disk.
      const prevOI = this.oiCache.get(coin) ?? openInterest;
      const oiChangePct = prevOI > 0 ? ((openInterest - prevOI) / prevOI) * 100 : 0;
      this.oiCache.set(coin, openInterest);

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

    // Sum top 10 levels for both sides
    const bidDepth = bids.slice(0, 10).reduce((sum, level) => sum + parseFloat(level.sz), 0);
    const askDepth = asks.slice(0, 10).reduce((sum, level) => sum + parseFloat(level.sz), 0);

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
      const size = parseFloat(trade.sz);
      const price = parseFloat(trade.px);
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