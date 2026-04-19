/**
 * Tests for the risk gate module.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RiskGate, DEFAULT_RISK_GATE_CONFIG } from './risk-gate.js';
import type { TradeDecision } from './scoring.js';
import type { PortfolioState } from './risk.js';
import type { MarketData } from './risk-gate.js';

describe('RiskGate', () => {
  let riskGate: RiskGate;
  let mockPortfolio: PortfolioState;
  let mockDecision: TradeDecision;
  let mockMarketData: MarketData;

  beforeEach(() => {
    riskGate = new RiskGate();
    mockPortfolio = {
      totalValue: 10000,
      positions: [],
      cash: 10000,
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: 0,
      initialValue: 10000,
    };
    mockDecision = {
      action: 'BUY',
      score: 0.5,
      signals: [],
      reasoning: 'test',
      confidence: 0.7,
      timestamp: Date.now(),
    };
    mockMarketData = {
      bid: 100,
      ask: 101,
      volume24hUsd: 1_000_000,
      marketCapUsd: 100_000_000,
      volatility: 0.05,
    };
  });

  describe('Confidence-based veto/downgrade', () => {
    it('should veto BUY when confidence is too low', () => {
      const decision = { ...mockDecision, action: 'BUY' as const, confidence: 0.3 };
      const result = riskGate.applyGate('bitcoin', decision, mockPortfolio, mockMarketData);

      expect(result.finalAction).toBe('HOLD');
      expect(result.wasGated).toBe(true);
      expect(result.reasons).toContain(
        expect.stringContaining('BUY_CONFIDENCE_VETO')
      );
    });

    it('should allow BUY when confidence is sufficient', () => {
      const decision = { ...mockDecision, action: 'BUY' as const, confidence: 0.5 };
      const result = riskGate.applyGate('bitcoin', decision, mockPortfolio, mockMarketData);

      expect(result.finalAction).toBe('BUY');
      expect(result.wasGated).toBe(false);
    });

    it('should downgrade STRONG_BUY to BUY in downgrade mode', () => {
      const config = { ...DEFAULT_RISK_GATE_CONFIG, hardVetoMode: false };
      const localGate = new RiskGate(config);
      const decision = { ...mockDecision, action: 'STRONG_BUY' as const, confidence: 0.3 };
      const result = localGate.applyGate('bitcoin', decision, mockPortfolio, mockMarketData);

      expect(result.finalAction).toBe('BUY');
      expect(result.wasGated).toBe(true);
      expect(result.reasons).toContain(
        expect.stringContaining('BUY_CONFIDENCE_DOWNGRADE')
      );
    });
  });

  describe('Liquidity quality checks', () => {
    it('should veto when spread is too wide', () => {
      const wideSpreadData = { ...mockMarketData, bid: 100, ask: 105 }; // 5% spread
      const result = riskGate.applyGate('bitcoin', mockDecision, mockPortfolio, wideSpreadData);

      expect(result.finalAction).toBe('HOLD');
      expect(result.wasGated).toBe(true);
      expect(result.reasons).toContain(
        expect.stringContaining('LIQUIDITY_VETO')
      );
    });

    it('should veto when volume is too low', () => {
      const lowVolumeData = { ...mockMarketData, volume24hUsd: 50_000 };
      const result = riskGate.applyGate('bitcoin', mockDecision, mockPortfolio, lowVolumeData);

      expect(result.finalAction).toBe('HOLD');
      expect(result.wasGated).toBe(true);
      expect(result.reasons).toContain(
        expect.stringContaining('LIQUIDITY_VETO')
      );
    });

    it('should downgrade when market data is missing', () => {
      const emptyData = {};
      const result = riskGate.applyGate('bitcoin', mockDecision, mockPortfolio, emptyData);

      expect(result.finalAction).toBe('HOLD');
      expect(result.wasGated).toBe(true);
      expect(result.reasons).toContain(
        expect.stringContaining('MISSING_MICROSTRUCTURE')
      );
    });

    it('should allow trades with good liquidity', () => {
      const goodData = {
        bid: 100,
        ask: 100.5, // 0.5% spread
        volume24hUsd: 5_000_000,
        marketCapUsd: 500_000_000,
      };
      const result = riskGate.applyGate('bitcoin', mockDecision, mockPortfolio, goodData);

      expect(result.finalAction).toBe('BUY');
      expect(result.wasGated).toBe(false);
    });
  });

  describe('High volatility downgrade', () => {
    it('should downgrade when volatility is high and confidence is low', () => {
      const highVolData = { ...mockMarketData, volatility: 0.15 }; // 15% volatility
      const lowConfDecision = { ...mockDecision, confidence: 0.5 };
      const result = riskGate.applyGate('bitcoin', lowConfDecision, mockPortfolio, highVolData);

      expect(result.finalAction).toBe('HOLD');
      expect(result.wasGated).toBe(true);
      expect(result.reasons).toContain(
        expect.stringContaining('HIGH_VOL_DOWNGRADE')
      );
    });

    it('should allow trades when volatility is high but confidence is sufficient', () => {
      const highVolData = { ...mockMarketData, volatility: 0.15 };
      const highConfDecision = { ...mockDecision, confidence: 0.7 };
      const result = riskGate.applyGate('bitcoin', highConfDecision, mockPortfolio, highVolData);

      expect(result.finalAction).toBe('BUY');
      expect(result.wasGated).toBe(false);
    });
  });

  describe('Turnover control', () => {
    it('should reject new entries when cycle limit reached', () => {
      // Simulate max entries reached
      riskGate.updateCycle(1);
      for (let i = 0; i < DEFAULT_RISK_GATE_CONFIG.maxConcurrentEntriesPerCycle; i++) {
        riskGate.recordPositionOpened(`token${i}`, 'long');
      }

      const result = riskGate.applyGate('new-token', mockDecision, mockPortfolio, mockMarketData);

      expect(result.finalAction).toBe('HOLD');
      expect(result.wasGated).toBe(true);
      expect(result.reasons).toContain(
        expect.stringContaining('TURNOVER_LIMIT')
      );
    });

    it('should allow new entries when under limit', () => {
      riskGate.updateCycle(1);
      riskGate.recordPositionOpened('token1', 'long');

      const result = riskGate.applyGate('token2', mockDecision, mockPortfolio, mockMarketData);

      expect(result.finalAction).toBe('BUY');
      expect(result.wasGated).toBe(false);
    });
  });

  describe('Short-side validation', () => {
    it('should validate short entry requirements', () => {
      const sellDecision = {
        ...mockDecision,
        action: 'SELL' as const,
        score: -0.35,
        confidence: 0.6,
      };
      const sellThreshold = -0.25;

      const result = riskGate.applyGate('bitcoin', sellDecision, mockPortfolio, mockMarketData, sellThreshold);

      expect(result.finalAction).toBe('SELL');
      expect(result.wasGated).toBe(false);
      expect(result.shortValidation?.confidencePassed).toBe(true);
      expect(result.shortValidation?.thresholdPassed).toBe(true);
    });

    it('should reject short when confidence is too low', () => {
      const sellDecision = {
        ...mockDecision,
        action: 'SELL' as const,
        score: -0.35,
        confidence: 0.4, // Below 0.55 threshold
      };
      const sellThreshold = -0.25;

      const result = riskGate.applyGate('bitcoin', sellDecision, mockPortfolio, mockMarketData, sellThreshold);

      expect(result.finalAction).toBe('HOLD');
      expect(result.wasGated).toBe(true);
      expect(result.shortValidation?.confidencePassed).toBe(false);
    });

    it('should reject short when threshold not met', () => {
      const sellDecision = {
        ...mockDecision,
        action: 'SELL' as const,
        score: -0.20, // Not far enough below threshold
        confidence: 0.6,
      };
      const sellThreshold = -0.25;

      const result = riskGate.applyGate('bitcoin', sellDecision, mockPortfolio, mockMarketData, sellThreshold);

      expect(result.finalAction).toBe('HOLD');
      expect(result.wasGated).toBe(true);
      expect(result.shortValidation?.thresholdPassed).toBe(false);
    });
  });

  describe('Minimum hold time', () => {
    it('should reject flip when minimum hold time not met', () => {
      riskGate.updateCycle(1);
      riskGate.recordPositionOpened('bitcoin', 'long');
      riskGate.updateCycle(2); // Only 1 cycle held

      const result = riskGate.applyGate('bitcoin', mockDecision, mockPortfolio, mockMarketData);

      expect(result.finalAction).toBe('HOLD');
      expect(result.wasGated).toBe(true);
      expect(result.reasons).toContain(
        expect.stringContaining('MIN_HOLD_TIME')
      );
    });

    it('should allow trades when minimum hold time met', () => {
      riskGate.updateCycle(1);
      riskGate.recordPositionOpened('bitcoin', 'long');
      riskGate.updateCycle(3); // 2 cycles held (meets minimum)

      const result = riskGate.applyGate('bitcoin', mockDecision, mockPortfolio, mockMarketData);

      expect(result.finalAction).toBe('BUY');
      expect(result.wasGated).toBe(false);
    });
  });

  describe('Cycle counters', () => {
    it('should track long and short positions opened', () => {
      riskGate.updateCycle(1);

      riskGate.recordPositionOpened('token1', 'long');
      riskGate.recordPositionOpened('token2', 'long');
      riskGate.recordPositionOpened('token3', 'short');

      const counters = riskGate.getCycleCounters();
      expect(counters.longsOpened).toBe(2);
      expect(counters.shortsOpened).toBe(1);
    });

    it('should reset counters on new cycle', () => {
      riskGate.updateCycle(1);
      riskGate.recordPositionOpened('token1', 'long');

      expect(riskGate.getCycleCounters().longsOpened).toBe(1);

      riskGate.updateCycle(2);
      expect(riskGate.getCycleCounters().longsOpened).toBe(0);
    });
  });

  describe('Configuration', () => {
    it('should use custom configuration', () => {
      const customConfig = {
        buyVetoConfidenceThreshold: 0.8,
        hardVetoMode: false,
      };
      const customGate = new RiskGate(customConfig);

      const decision = { ...mockDecision, confidence: 0.6 };
      const result = customGate.applyGate('bitcoin', decision, mockPortfolio, mockMarketData);

      expect(result.finalAction).toBe('HOLD');
      expect(result.wasGated).toBe(true);
    });

    it('should allow config updates', () => {
      const decision = { ...mockDecision, confidence: 0.3 };

      // Should veto with default config
      let result = riskGate.applyGate('bitcoin', decision, mockPortfolio, mockMarketData);
      expect(result.wasGated).toBe(true);

      // Update config to lower threshold
      riskGate.updateConfig({ buyVetoConfidenceThreshold: 0.2 });

      // Should now allow
      result = riskGate.applyGate('bitcoin', decision, mockPortfolio, mockMarketData);
      expect(result.wasGated).toBe(false);
    });
  });
});