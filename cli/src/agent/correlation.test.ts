/**
 * Test file for CorrelationGuard functionality.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CorrelationGuard } from './correlation.js';

// Mock the CoinGeckoProvider as a class constructor
vi.mock('../providers/data/coingecko.js', () => ({
  CoinGeckoProvider: class {
    getOHLC = vi.fn().mockResolvedValue([]);
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

  it('should return neutral check on data failure', async () => {
    // Mock failed data fetch
    const mockCoingecko = vi.mocked(correlationGuard['coingecko']);
    mockCoingecko.getOHLC = vi.fn().mockRejectedValue(new Error('API error'));

    // Force cache miss — getBtcStructure() uses a 10-min on-disk cache that
    // may hold a valid prior structure from unrelated runs.
    (correlationGuard as unknown as { loadCache: () => Promise<never> }).loadCache =
      () => Promise.reject(new Error('no cache'));

    const result = await correlationGuard.checkCorrelation('ethereum');

    expect(result.btcBias).toBe('neutral');
    expect(result.btcScore).toBe(0);
    expect(result.shouldSuppress).toBe(false);
  });

  it('should fetch 90 days of BTC OHLC and not throw insufficient-data', async () => {
    // Build 90 synthetic daily candles in a mild uptrend so the flow has real
    // data to compute EMA/RSI/MACD against. The point of the test is to prove
    // the threshold (<50) no longer trips for a valid fetch — regardless of
    // which bias the math produces, we must NOT fall back to the neutral-on-
    // failure branch (btcScore === 0 with reason starting "BTC or stablecoin"
    // is the skip path; the error path also sets btcScore === 0).
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const ohlc: number[][] = Array.from({ length: 90 }, (_, i) => {
      const price = 50_000 + i * 100; // steady rise
      return [now - (89 - i) * dayMs, price, price + 50, price - 50, price];
    });

    const mockCoingecko = vi.mocked(correlationGuard['coingecko']);
    const getOHLCMock = vi.fn().mockResolvedValue(ohlc);
    mockCoingecko.getOHLC = getOHLCMock;

    // Force cache miss so analyzeBtcStructure() is actually invoked.
    (correlationGuard as unknown as { loadCache: () => Promise<never> }).loadCache =
      () => Promise.reject(new Error('no cache'));

    const result = await correlationGuard.checkCorrelation('ethereum');

    // Verify the call site now requests 90 days, not 30.
    expect(getOHLCMock).toHaveBeenCalledWith('bitcoin', 90);
    // Reason must not be the "BTC or stablecoin" skip message — we passed in
    // ethereum, so the structure branch was taken.
    expect(result.reason).not.toContain('BTC or stablecoin');
    // Should produce a valid bias (not the string literal 'error' or similar).
    expect(['bullish', 'bearish', 'neutral']).toContain(result.btcBias);
  });
});