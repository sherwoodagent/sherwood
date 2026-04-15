/**
 * Tests for MultiTimeframeStrategy
 */

import { describe, it, expect } from 'vitest';
import { MultiTimeframeStrategy } from './multi-timeframe.js';
import type { StrategyContext, Candle } from './types.js';

function createMockCandles(days: number, trend: 'up' | 'down' | 'sideways'): Candle[] {
  const candles: Candle[] = [];
  const basePrice = 100;
  let currentPrice = basePrice;

  for (let i = 0; i < days; i++) {
    const open = currentPrice;
    let close: number;

    switch (trend) {
      case 'up':
        // Stronger upward trend with consistent gains
        close = open + 0.5 + Math.random() * 1.5; // +0.5 to +2.0 per day
        break;
      case 'down':
        // Stronger downward trend with consistent losses
        close = open - 0.5 - Math.random() * 1.5; // -0.5 to -2.0 per day
        break;
      case 'sideways':
        close = open + (Math.random() - 0.5) * 0.3; // Small oscillations
        break;
    }

    const high = Math.max(open, close) + Math.random() * 0.5;
    const low = Math.min(open, close) - Math.random() * 0.5;
    const volume = 1000 + Math.random() * 500;
    const timestamp = Date.now() - (days - i) * 24 * 60 * 60 * 1000;

    candles.push({ timestamp, open, high, low, close, volume });
    currentPrice = close;
  }

  return candles;
}

describe('MultiTimeframeStrategy', () => {
  const strategy = new MultiTimeframeStrategy();

  it('should require sufficient data', async () => {
    const ctx: StrategyContext = {
      tokenId: 'ethereum',
      candles: createMockCandles(10, 'up'), // Not enough days
    };

    const signal = await strategy.analyze(ctx);

    expect(signal.name).toBe('multiTimeframe');
    expect(signal.value).toBe(0.0);
    expect(signal.confidence).toBe(0.1);
    expect(signal.details).toContain('Insufficient candle data');
  });

  it('should detect bullish confluence', async () => {
    const ctx: StrategyContext = {
      tokenId: 'ethereum',
      candles: createMockCandles(50, 'up'), // Strong uptrend
    };

    const signal = await strategy.analyze(ctx);

    expect(signal.name).toBe('multiTimeframe');
    expect(signal.value).toBeGreaterThan(0);
    expect(signal.confidence).toBeGreaterThan(0.4);
  });

  it('should detect bearish confluence', async () => {
    const ctx: StrategyContext = {
      tokenId: 'ethereum',
      candles: createMockCandles(50, 'down'), // Strong downtrend
    };

    const signal = await strategy.analyze(ctx);

    expect(signal.name).toBe('multiTimeframe');
    expect(signal.value).toBeLessThan(0);
    expect(signal.confidence).toBeGreaterThan(0.4);
  });

  it('should handle sideways market', async () => {
    const ctx: StrategyContext = {
      tokenId: 'ethereum',
      candles: createMockCandles(50, 'sideways'),
    };

    const signal = await strategy.analyze(ctx);

    expect(signal.name).toBe('multiTimeframe');
    expect(Math.abs(signal.value)).toBeLessThan(0.5); // Should be neutral-ish
    expect(signal.details.length).toBeGreaterThan(0);
  });

  it('should handle missing candles gracefully', async () => {
    const ctx: StrategyContext = {
      tokenId: 'ethereum',
    };

    const signal = await strategy.analyze(ctx);

    expect(signal.name).toBe('multiTimeframe');
    expect(signal.value).toBe(0.0);
    expect(signal.confidence).toBe(0.1);
  });

  it('should include timeframe breakdown in details', async () => {
    const ctx: StrategyContext = {
      tokenId: 'ethereum',
      candles: createMockCandles(40, 'up'),
    };

    const signal = await strategy.analyze(ctx);

    expect(signal.details).toContain('Short-term:');
    expect(signal.details).toContain('Daily:');
    expect(signal.details).toContain('Weekly:');
    expect(signal.details).toContain('trend:');
    expect(signal.details).toContain('momentum:');
    expect(signal.details).toContain('structure:');
  });

});