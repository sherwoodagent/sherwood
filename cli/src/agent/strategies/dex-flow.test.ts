/**
 * Tests for DexFlowStrategy — specifically the one-sided-flow guard that
 * prevents false bullish/bearish on absence of counter-flow.
 */

import { describe, it, expect } from 'vitest';
import { DexFlowStrategy } from './dex-flow.js';
import type { StrategyContext } from './types.js';
import type { DexPair } from '../../providers/data/dexscreener.js';

function makePair(overrides: {
  h1Buys: number;
  h1Sells: number;
  h24Buys?: number;
  h24Sells?: number;
  liquidity?: number;
  volume24h?: number;
}): DexPair {
  return {
    chainId: 'base',
    dexId: 'uniswap',
    pairAddress: '0xpair',
    baseToken: { address: '0xbase', name: 'Test', symbol: 'TEST' },
    quoteToken: { address: '0xquote', name: 'USDC', symbol: 'USDC' },
    priceUsd: '1.00',
    priceChange: { h1: 0, h6: 0, h24: 0 },
    volume: { h1: 0, h6: 0, h24: overrides.volume24h ?? 1_000_000 },
    liquidity: { usd: overrides.liquidity ?? 500_000 },
    fdv: 10_000_000,
    txns: {
      h1: { buys: overrides.h1Buys, sells: overrides.h1Sells },
      h24: {
        buys: overrides.h24Buys ?? overrides.h1Buys * 10,
        sells: overrides.h24Sells ?? overrides.h1Sells * 10,
      },
    },
  };
}

function ctxFor(pair: DexPair): StrategyContext {
  return {
    tokenId: 'test-token',
    dexData: [pair],
  };
}

describe('DexFlowStrategy — one-sided-flow guard', () => {
  const strategy = new DexFlowStrategy();

  it('returns neutral when 1h flow is one-sided (5 buys / 0 sells)', async () => {
    // Also zero out 24h to isolate the 1h guard
    const pair = makePair({ h1Buys: 5, h1Sells: 0, h24Buys: 50, h24Sells: 0 });
    const signal = await strategy.analyze(ctxFor(pair));

    expect(signal.name).toBe('dexFlow');
    expect(signal.value).toBe(0);
    expect(signal.confidence).toBeLessThanOrEqual(0.4);
  });

  it('returns neutral when 1h flow is one-sided (0 buys / 5 sells)', async () => {
    const pair = makePair({ h1Buys: 0, h1Sells: 5, h24Buys: 0, h24Sells: 50 });
    const signal = await strategy.analyze(ctxFor(pair));

    expect(signal.value).toBe(0);
    expect(signal.confidence).toBeLessThanOrEqual(0.4);
  });

  it('fires bullish on genuine two-sided buy pressure (50 buys / 5 sells)', async () => {
    const pair = makePair({ h1Buys: 50, h1Sells: 5 });
    const signal = await strategy.analyze(ctxFor(pair));

    expect(signal.value).toBeGreaterThan(0);
    expect(signal.details).toContain('bullish');
  });

  it('fires bearish on genuine two-sided sell pressure (5 buys / 50 sells)', async () => {
    const pair = makePair({ h1Buys: 5, h1Sells: 50 });
    const signal = await strategy.analyze(ctxFor(pair));

    expect(signal.value).toBeLessThan(0);
    expect(signal.details).toContain('bearish');
  });

  it('returns neutral when total activity is below threshold (3 buys / 2 sells)', async () => {
    const pair = makePair({ h1Buys: 3, h1Sells: 2, h24Buys: 6, h24Sells: 4 });
    const signal = await strategy.analyze(ctxFor(pair));

    expect(signal.value).toBe(0);
  });
});
