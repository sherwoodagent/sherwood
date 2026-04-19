/**
 * Tests for backtest validation utilities.
 */

import { describe, test, expect } from 'vitest';
import { validateLookaheadGuard, LookaheadStructuralGuard } from './backtest-validator.js';
import type { Candle } from './technical.js';

describe('BacktestValidator', () => {
  const mockCandles: Candle[] = [
    { timestamp: 1000, open: 100, high: 105, low: 95, close: 102, volume: 1000000 },
    { timestamp: 2000, open: 102, high: 108, low: 98, close: 104, volume: 1200000 },
    { timestamp: 3000, open: 104, high: 110, low: 100, close: 106, volume: 800000 },
    { timestamp: 4000, open: 106, high: 112, low: 102, close: 108, volume: 900000 },
    { timestamp: 5000, open: 108, high: 114, low: 104, close: 110, volume: 1100000 },
  ];

  describe('validateLookaheadGuard', () => {
    test('passes with proper historical window', () => {
      const currentIndex = 3; // Looking at candle at index 3
      const windowCandles = mockCandles.slice(0, 3); // Using candles 0,1,2

      const result = validateLookaheadGuard(currentIndex, mockCandles, windowCandles);

      expect(result.status).toBe('PASS');
      expect(result.message).toBe('No lookahead bias detected');
    });

    test('fails with future data in window', () => {
      const currentIndex = 2; // Looking at candle at index 2 (timestamp 3000)
      const windowCandles = [
        mockCandles[1]!, // Past data (timestamp 2000) - OK
        mockCandles[3]!, // Future data (timestamp 4000) - BAD
      ];

      const result = validateLookaheadGuard(currentIndex, mockCandles, windowCandles);

      expect(result.status).toBe('FAIL');
      expect(result.message).toBe('Future data detected in analysis window');
    });

    test('warns when current candle included in window', () => {
      const currentIndex = 2;
      const windowCandles = [
        mockCandles[0]!, // Past data
        mockCandles[1]!, // Past data
        mockCandles[2]!, // Current candle - WARN
      ];

      const result = validateLookaheadGuard(currentIndex, mockCandles, windowCandles);

      expect(result.status).toBe('WARN');
      expect(result.message).toBe('Current candle included in analysis window');
    });

    test('handles edge case with empty window', () => {
      const result = validateLookaheadGuard(2, mockCandles, []);

      expect(result.status).toBe('PASS');
      expect(result.details[0]).toContain('0 candles are from past/present');
    });
  });

  describe('LookaheadStructuralGuard', () => {
    test('allows access to current and past indices', () => {
      const guard = new LookaheadStructuralGuard(2, 5);

      expect(guard.validateAccess(0)).toBe(true); // Past
      expect(guard.validateAccess(1)).toBe(true); // Past
      expect(guard.validateAccess(2)).toBe(true); // Current - should this be allowed?
    });

    test('blocks access to future indices', () => {
      const guard = new LookaheadStructuralGuard(2, 5);

      expect(guard.validateAccess(3)).toBe(false); // Future
      expect(guard.validateAccess(4)).toBe(false); // Future
    });

    test('createGuardedArray throws on future access', () => {
      const guard = new LookaheadStructuralGuard(2, 5);
      const guardedArray = guard.createGuardedArray(['a', 'b', 'c', 'd', 'e']);

      // Should work for valid indices
      expect(guardedArray[0]).toBe('a');
      expect(guardedArray[1]).toBe('b');
      expect(guardedArray[2]).toBe('c');

      // Should throw for future indices
      expect(() => guardedArray[3]).toThrow('Lookahead violation');
      expect(() => guardedArray[4]).toThrow('Lookahead violation');
    });

    test('createGuardedArray allows normal array operations', () => {
      const guard = new LookaheadStructuralGuard(2, 5);
      const guardedArray = guard.createGuardedArray([10, 20, 30, 40, 50]);

      expect(guardedArray.length).toBe(5);
      expect(guardedArray.slice(0, 3)).toEqual([10, 20, 30]);
      expect(guardedArray.indexOf(20)).toBe(1);
    });

    test('handles edge cases', () => {
      // Guard at the beginning
      const startGuard = new LookaheadStructuralGuard(0, 3);
      expect(startGuard.validateAccess(0)).toBe(true);
      expect(startGuard.validateAccess(1)).toBe(false);
      expect(startGuard.validateAccess(2)).toBe(false);

      // Guard at the end
      const endGuard = new LookaheadStructuralGuard(2, 3);
      expect(endGuard.validateAccess(0)).toBe(true);
      expect(endGuard.validateAccess(1)).toBe(true);
      expect(endGuard.validateAccess(2)).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    test('typical backtest loop pattern', () => {
      const allCandles = mockCandles;

      for (let i = 1; i < allCandles.length; i++) {
        const windowCandles = allCandles.slice(Math.max(0, i - 2), i);
        const guard = new LookaheadStructuralGuard(i, allCandles.length);

        // Validate the window
        const validation = validateLookaheadGuard(i, allCandles, windowCandles);
        expect(validation.status).toBe('PASS');

        // Create guarded access
        const guardedCandles = guard.createGuardedArray(allCandles);

        // Should be able to access current and past
        for (let j = 0; j <= i; j++) {
          expect(() => guardedCandles[j]).not.toThrow();
        }

        // Should not be able to access future
        for (let j = i + 1; j < allCandles.length; j++) {
          expect(() => guardedCandles[j]).toThrow();
        }
      }
    });

    test('window construction edge cases', () => {
      // Very small window
      const validation1 = validateLookaheadGuard(1, mockCandles, [mockCandles[0]!]);
      expect(validation1.status).toBe('PASS');

      // Empty candles array
      const validation2 = validateLookaheadGuard(0, [], []);
      expect(validation2.status).toBe('PASS');
    });
  });
});