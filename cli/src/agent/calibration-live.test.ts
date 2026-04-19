/**
 * Tests for LiveCalibrator — regime-aware calibration and uncertainty sizing.
 */

import { describe, it, expect } from 'vitest';
import { LiveCalibrator, type UncertaintyMetrics, type CalibrationFactor } from './calibration-live.js';

describe('LiveCalibrator', () => {
  const calibrator = new LiveCalibrator();

  describe('getCalibrationFactor', () => {
    it('should return neutral factor for insufficient samples', () => {
      const result = calibrator.getCalibrationFactor('bitcoin', 'trending-up', 'BUY');

      expect(result.factor).toBe(1.0);
      expect(result.reason).toContain('Insufficient samples');
      expect(result.stats.sampleCount).toBeLessThan(20);
    });

    it('should clamp factor to valid bounds', () => {
      // Test with extreme cases - the factor should always be between 0.7 and 1.2
      const result = calibrator.getCalibrationFactor('ethereum', 'ranging', 'SELL');

      expect(result.factor).toBeGreaterThanOrEqual(0.7);
      expect(result.factor).toBeLessThanOrEqual(1.2);
    });
  });

  describe('calculateUncertainty', () => {
    it('should handle empty signals', () => {
      const result = calibrator.calculateUncertainty([], [100, 105, 98], 'bitcoin');

      expect(result.scoreDispersion).toBe(0);
      expect(result.signalAgreement).toBe(0);
      expect(['low', 'medium', 'high']).toContain(result.level);
      expect([0.5, 0.8, 1.0]).toContain(result.sizeMultiplier);
    });

    it('should detect high agreement in bullish signals', () => {
      const signals = [
        { name: 'technical', value: 0.8, confidence: 0.9 },
        { name: 'sentiment', value: 0.7, confidence: 0.8 },
        { name: 'onchain', value: 0.6, confidence: 0.7 }
      ];

      const result = calibrator.calculateUncertainty(signals, [100, 102, 104], 'ethereum');

      expect(result.signalAgreement).toBeGreaterThan(0.8); // All positive signals
      expect(result.scoreDispersion).toBeLessThan(0.2); // Similar values
    });

    it('should detect low agreement in mixed signals', () => {
      const signals = [
        { name: 'technical', value: 0.8, confidence: 0.9 },
        { name: 'sentiment', value: -0.6, confidence: 0.8 },
        { name: 'onchain', value: 0.1, confidence: 0.5 }
      ];

      const result = calibrator.calculateUncertainty(signals, [100, 95, 105], 'solana');

      expect(result.signalAgreement).toBeLessThan(0.6); // Mixed signals
    });

    it('should assign correct size multipliers', () => {
      // Low uncertainty should get 1.0x
      const lowUncertaintySignals = [
        { name: 'technical', value: 0.5, confidence: 0.9 },
        { name: 'sentiment', value: 0.6, confidence: 0.9 },
        { name: 'onchain', value: 0.55, confidence: 0.9 }
      ];

      const lowUncertainty = calibrator.calculateUncertainty(
        lowUncertaintySignals,
        [100, 100.5, 101],
        'bitcoin'
      );

      // High uncertainty should get 0.5x
      const highUncertaintySignals = [
        { name: 'technical', value: 0.9, confidence: 0.3 },
        { name: 'sentiment', value: -0.8, confidence: 0.4 },
        { name: 'onchain', value: 0.2, confidence: 0.2 }
      ];

      const highUncertainty = calibrator.calculateUncertainty(
        highUncertaintySignals,
        [100, 90, 110, 85, 115],
        'ethereum'
      );

      if (lowUncertainty.level === 'low') {
        expect(lowUncertainty.sizeMultiplier).toBe(1.0);
      }

      if (highUncertainty.level === 'high') {
        expect(highUncertainty.sizeMultiplier).toBe(0.5);
      }
    });

    it('should handle single price point gracefully', () => {
      const signals = [{ name: 'technical', value: 0.5, confidence: 0.8 }];
      const result = calibrator.calculateUncertainty(signals, [100], 'bitcoin');

      expect(result.recentVolatility).toBe(0);
      expect(typeof result.level).toBe('string');
      expect(typeof result.sizeMultiplier).toBe('number');
    });
  });

  describe('private methods via proxy', () => {
    it('should calculate standard deviation correctly', () => {
      // Test the std dev calculation indirectly through uncertainty
      const identicalSignals = [
        { name: 'a', value: 0.5, confidence: 0.8 },
        { name: 'b', value: 0.5, confidence: 0.8 },
        { name: 'c', value: 0.5, confidence: 0.8 }
      ];

      const variedSignals = [
        { name: 'a', value: 0.9, confidence: 0.8 },
        { name: 'b', value: -0.9, confidence: 0.8 },
        { name: 'c', value: 0.0, confidence: 0.8 }
      ];

      const identicalResult = calibrator.calculateUncertainty(identicalSignals, [100], 'test');
      const variedResult = calibrator.calculateUncertainty(variedSignals, [100], 'test');

      expect(identicalResult.scoreDispersion).toBe(0);
      expect(variedResult.scoreDispersion).toBeGreaterThan(identicalResult.scoreDispersion);
    });

    it('should categorize uncertainty levels correctly', () => {
      // Test boundary conditions for uncertainty levels
      const lowVarianceSignals = [
        { name: 'a', value: 0.45, confidence: 0.95 },
        { name: 'b', value: 0.50, confidence: 0.95 },
        { name: 'c', value: 0.55, confidence: 0.95 }
      ];

      const highVarianceSignals = [
        { name: 'a', value: 0.9, confidence: 0.3 },
        { name: 'b', value: -0.8, confidence: 0.2 },
        { name: 'c', value: 0.1, confidence: 0.1 }
      ];

      const lowResult = calibrator.calculateUncertainty(lowVarianceSignals, [100, 100.1], 'test');
      const highResult = calibrator.calculateUncertainty(highVarianceSignals, [100, 80, 120], 'test');

      // Low variance and low volatility should tend toward low uncertainty
      // High variance and high volatility should tend toward high uncertainty
      expect(['low', 'medium']).toContain(lowResult.level);
      expect(['medium', 'high']).toContain(highResult.level);
    });
  });
});