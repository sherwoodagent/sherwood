/**
 * Test file for CorrelationGuard functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CorrelationGuard } from './correlation.js';

// Mock BOTH providers — HL is now the primary path, CG is fallback.
vi.mock('../providers/data/coingecko.js', () => ({
  CoinGeckoProvider: class {
    getOHLC = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock('../providers/data/hyperliquid.js', () => ({
  HyperliquidProvider: class {
    getHyperliquidData = vi.fn().mockResolvedValue(null);
  },
  // safeNumber is imported by other modules — passthrough
  safeNumber: (x: unknown) => {
    const n = typeof x === 'number' ? x : parseFloat(x as string);
    return Number.isFinite(n) ? n : null;
  },
}));

describe('CorrelationGuard', () => {
  let correlationGuard: CorrelationGuard;

  beforeEach(() => {
    correlationGuard = new CorrelationGuard();
  });

  it('should skip correlation check for BTC', async () => {
    const result = await correlationGuard.checkCorrelation('bitcoin');

    expect(result.btcBias).toBe('neutral');
    expect(result.shouldSuppress).toBe(false);
    expect(result.suppressionFactor).toBe(1.0);
    expect(result.reason).toContain('BTC or stablecoin');
  });

  it('should skip correlation check for stablecoins', async () => {
    const result = await correlationGuard.checkCorrelation('tether');

    expect(result.btcBias).toBe('neutral');
    expect(result.shouldSuppress).toBe(false);
    expect(result.suppressionFactor).toBe(1.0);
    expect(result.reason).toContain('BTC or stablecoin');
  });

  it('should return neutral check when both HL and CG fail', async () => {
    // HL returns null (default mock), CG throws
    const mockCoingecko = vi.mocked(correlationGuard['coingecko']);
    mockCoingecko.getOHLC = vi.fn().mockRejectedValue(new Error('API error'));

    (correlationGuard as unknown as { loadCache: () => Promise<never> }).loadCache =
      () => Promise.reject(new Error('no cache'));

    const result = await correlationGuard.checkCorrelation('ethereum');

    expect(result.btcBias).toBe('neutral');
    expect(result.btcScore).toBe(0);
    expect(result.shouldSuppress).toBe(false);
  });

  it('should use Hyperliquid data as primary source', async () => {
    const mockHL = vi.mocked(correlationGuard['hyperliquid']);
    mockHL.getHyperliquidData = vi.fn().mockResolvedValue({
      markPrice: 85000,
      prevDayPrice: 82000,  // +3.7% → bullish
      fundingRate: -0.0002, // negative funding → bullish
      openInterest: 5e9,
      oiChangePct: 2,
      volume24h: 1e9,
      oraclePrice: 85000,
      orderBookImbalance: 0.3,  // bid-heavy → bullish
      largeTradesBias: 0.4,      // large buys → bullish
    });

    (correlationGuard as unknown as { loadCache: () => Promise<never> }).loadCache =
      () => Promise.reject(new Error('no cache'));

    const result = await correlationGuard.checkCorrelation('ethereum');

    // Strong bullish: +3.7% day, negative funding, heavy bid-side flow
    expect(result.btcBias).toBe('bullish');
    expect(result.btcScore).toBeGreaterThan(0.3);
    expect(result.shouldSuppress).toBe(false);
  });

  it('should fall back to CG when HL returns null', async () => {
    // HL returns null (default mock)
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const ohlc: number[][] = Array.from({ length: 90 }, (_, i) => {
      const price = 50_000 + i * 100; // steady rise
      return [now - (89 - i) * dayMs, price, price + 50, price - 50, price];
    });

    const mockCoingecko = vi.mocked(correlationGuard['coingecko']);
    const getOHLCMock = vi.fn().mockResolvedValue(ohlc);
    mockCoingecko.getOHLC = getOHLCMock;

    (correlationGuard as unknown as { loadCache: () => Promise<never> }).loadCache =
      () => Promise.reject(new Error('no cache'));

    const result = await correlationGuard.checkCorrelation('ethereum');

    expect(getOHLCMock).toHaveBeenCalledWith('bitcoin', 90);
    expect(result.reason).not.toContain('BTC or stablecoin');
    expect(['bullish', 'bearish', 'neutral']).toContain(result.btcBias);
  });

  it('should NOT persist fallback when both HL and CG fail', async () => {
    const saveCacheSpy = vi.fn().mockResolvedValue(undefined);
    (correlationGuard as unknown as { saveCache: typeof saveCacheSpy }).saveCache = saveCacheSpy;
    (correlationGuard as unknown as { loadCache: () => Promise<never> }).loadCache =
      () => Promise.reject(new Error('no cache'));

    // HL returns null, CG throws
    const mockCoingecko = vi.mocked(correlationGuard['coingecko']);
    mockCoingecko.getOHLC = vi.fn().mockRejectedValue(new Error('429 rate limited'));

    await correlationGuard.checkCorrelation('ethereum');

    expect(saveCacheSpy).not.toHaveBeenCalled();
  });

  it('should prefer stale-but-real cache over fresh fallback', async () => {
    const STALE_MS = 2 * 60 * 60 * 1000;
    (correlationGuard as unknown as { loadCache: () => Promise<{ timestamp: number; btcStructure: { price: number; ema50: number; ema200: number; rsi: number; macdDirection: string; score: number } }> }).loadCache =
      () => Promise.resolve({
        timestamp: Date.now() - STALE_MS,
        btcStructure: { price: 70000, ema50: 68000, ema200: 65000, rsi: 55, macdDirection: 'bullish', score: 0.4 },
      });

    // HL returns null, CG throws
    const mockCoingecko = vi.mocked(correlationGuard['coingecko']);
    mockCoingecko.getOHLC = vi.fn().mockRejectedValue(new Error('429 rate limited'));

    const result = await correlationGuard.checkCorrelation('ethereum');

    expect(result.btcBias).toBe('bullish');
  });

  it('should detect bearish structure from HL data', async () => {
    const mockHL = vi.mocked(correlationGuard['hyperliquid']);
    mockHL.getHyperliquidData = vi.fn().mockResolvedValue({
      markPrice: 75000,
      prevDayPrice: 79000,  // -5% → bearish
      fundingRate: 0.0003,  // positive → longs crowded → bearish
      openInterest: 5e9,
      oiChangePct: -3,
      volume24h: 1e9,
      oraclePrice: 75000,
      orderBookImbalance: -0.3,
      largeTradesBias: -0.4,
    });

    (correlationGuard as unknown as { loadCache: () => Promise<never> }).loadCache =
      () => Promise.reject(new Error('no cache'));

    const result = await correlationGuard.checkCorrelation('ethereum');

    expect(result.btcBias).toBe('bearish');
    expect(result.btcScore).toBeLessThan(-0.3);
    expect(result.shouldSuppress).toBe(true);
  });
});
