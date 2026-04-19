/**
 * Tests for slippage and execution realism model.
 */

import { describe, test, expect } from 'vitest';
import { calculateExecutionPrice, calculateAggregateSlippage, DEFAULT_SLIPPAGE_CONFIG } from './slippage-model.js';
import type { Candle } from './technical.js';

describe('SlippageModel', () => {
  const mockCandles: Candle[] = [
    { timestamp: 1000, open: 100, high: 105, low: 95, close: 102, volume: 1000000 },
    { timestamp: 2000, open: 102, high: 108, low: 98, close: 104, volume: 1200000 },
    { timestamp: 3000, open: 104, high: 110, low: 100, close: 106, volume: 800000 },
    { timestamp: 4000, open: 106, high: 112, low: 102, close: 108, volume: 900000 },
    { timestamp: 5000, open: 108, high: 114, low: 104, close: 110, volume: 1100000 },
  ];

  test('calculateExecutionPrice - basic slippage for BUY', () => {
    const result = calculateExecutionPrice(100, 'BUY', 5000, mockCandles, DEFAULT_SLIPPAGE_CONFIG);

    expect(result.marketPrice).toBe(100);
    expect(result.executionPrice).toBeGreaterThan(100); // BUY should have worse price
    expect(result.totalSlippage).toBeGreaterThan(0);
    expect(result.breakdown.baseSlippage).toBe(0.0008); // 8 bps
    expect(result.breakdown.feesImpact).toBe(0.0005); // 5 bps fees
  });

  test('calculateExecutionPrice - basic slippage for SELL', () => {
    const result = calculateExecutionPrice(100, 'SELL', 5000, mockCandles, DEFAULT_SLIPPAGE_CONFIG);

    expect(result.marketPrice).toBe(100);
    expect(result.executionPrice).toBeLessThan(100); // SELL should have worse price
    expect(result.totalSlippage).toBeGreaterThan(0);
  });

  test('calculateExecutionPrice - larger position increases size penalty', () => {
    const smallPosition = calculateExecutionPrice(100, 'BUY', 1000, mockCandles, DEFAULT_SLIPPAGE_CONFIG);
    const largePosition = calculateExecutionPrice(100, 'BUY', 50000, mockCandles, DEFAULT_SLIPPAGE_CONFIG);

    expect(largePosition.breakdown.sizePenalty).toBeGreaterThan(smallPosition.breakdown.sizePenalty);
    expect(largePosition.totalSlippage).toBeGreaterThan(smallPosition.totalSlippage);
  });

  test('calculateExecutionPrice - volatility penalty with high ATR', () => {
    // Create enough high volatility candles for ATR calculation (need 14+ for ATR)
    const highVolCandles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      highVolCandles.push({
        timestamp: 1000 + i * 1000,
        open: 100 + (i % 2 ? 10 : -10), // Alternating high/low opens
        high: 100 + (i % 2 ? 25 : 5),  // High volatility ranges
        low: 100 + (i % 2 ? -5 : -25),
        close: 100 + (i % 3 - 1) * 8,  // Varying closes
        volume: 1000000
      });
    }

    // Extend mockCandles to have enough data points for ATR
    const extendedMockCandles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      extendedMockCandles.push({
        timestamp: 1000 + i * 1000,
        open: 100 + i * 0.1,
        high: 105 + i * 0.1,
        low: 95 + i * 0.1,
        close: 102 + i * 0.1,
        volume: 1000000
      });
    }

    const highVolResult = calculateExecutionPrice(100, 'BUY', 5000, highVolCandles, DEFAULT_SLIPPAGE_CONFIG);
    const lowVolResult = calculateExecutionPrice(100, 'BUY', 5000, extendedMockCandles, DEFAULT_SLIPPAGE_CONFIG);

    expect(highVolResult.breakdown.volatilityPenalty).toBeGreaterThan(lowVolResult.breakdown.volatilityPenalty);
  });

  test('calculateExecutionPrice - zero volume graceful fallback', () => {
    // Create enough zero volume candles for ATR calculation
    const zeroVolCandles = [];
    for (let i = 0; i < 20; i++) {
      zeroVolCandles.push({
        timestamp: 1000 + i * 1000,
        open: 100 + i * 0.1,
        high: 105 + i * 0.1,
        low: 95 + i * 0.1,
        close: 102 + i * 0.1,
        volume: 0
      });
    }

    const result = calculateExecutionPrice(100, 'BUY', 5000, zeroVolCandles, DEFAULT_SLIPPAGE_CONFIG);

    expect(result.executionPrice).toBeGreaterThan(100);
    expect(result.totalSlippage).toBeGreaterThan(0);
    expect(Number.isFinite(result.executionPrice)).toBe(true);
    expect(Number.isFinite(result.totalSlippage)).toBe(true);
  });

  test('calculateAggregateSlippage - empty executions', () => {
    const result = calculateAggregateSlippage([]);

    expect(result.totalSlippageCost).toBe(0);
    expect(result.avgSlippagePct).toBe(0);
    expect(result.maxSlippagePct).toBe(0);
  });

  test('calculateAggregateSlippage - multiple executions', () => {
    const executions = [
      calculateExecutionPrice(100, 'BUY', 5000, mockCandles, DEFAULT_SLIPPAGE_CONFIG),
      calculateExecutionPrice(105, 'SELL', 5000, mockCandles, DEFAULT_SLIPPAGE_CONFIG),
      calculateExecutionPrice(102, 'BUY', 3000, mockCandles, DEFAULT_SLIPPAGE_CONFIG),
    ];

    const result = calculateAggregateSlippage(executions);

    expect(result.totalSlippageCost).toBeGreaterThan(0);
    expect(result.avgSlippagePct).toBeGreaterThan(0);
    expect(result.maxSlippagePct).toBeGreaterThanOrEqual(result.avgSlippagePct);
    expect(executions.length).toBe(3);
  });

  test('slippage components sum correctly', () => {
    const result = calculateExecutionPrice(100, 'BUY', 5000, mockCandles, DEFAULT_SLIPPAGE_CONFIG);

    const expectedTotal = result.breakdown.baseSlippage +
                         result.breakdown.volatilityPenalty +
                         result.breakdown.sizePenalty +
                         result.breakdown.feesImpact;

    expect(Math.abs(result.totalSlippage - expectedTotal)).toBeLessThan(0.0001);
  });

  test('extreme market conditions', () => {
    // Test with very small position
    const tinyResult = calculateExecutionPrice(100, 'BUY', 10, mockCandles, DEFAULT_SLIPPAGE_CONFIG);
    expect(tinyResult.totalSlippage).toBeGreaterThan(0);

    // Test with very large position
    const hugeResult = calculateExecutionPrice(100, 'BUY', 10000000, mockCandles, DEFAULT_SLIPPAGE_CONFIG);
    expect(hugeResult.breakdown.sizePenalty).toBeLessThanOrEqual(0.05); // Capped at 5%
  });
});