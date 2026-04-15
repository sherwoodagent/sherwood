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

    const result = await correlationGuard.checkCorrelation('ethereum');

    expect(result.btcBias).toBe('neutral');
    expect(result.btcScore).toBe(0);
    expect(result.shouldSuppress).toBe(false);
  });
});