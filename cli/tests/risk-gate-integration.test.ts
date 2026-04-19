/**
 * Integration tests for risk gate turnover control and short-side validation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RiskGate } from '../src/agent/risk-gate.js';
import type { TradeDecision } from '../src/agent/scoring.js';
import type { PortfolioState } from '../src/agent/risk.js';

describe('Risk Gate Integration Tests', () => {
  let riskGate: RiskGate;
  let mockPortfolio: PortfolioState;

  beforeEach(() => {
    riskGate = new RiskGate({
      maxConcurrentEntriesPerCycle: 8,
      maxReplacementsPerCycle: 2,
      minHoldCycles: 2,
      shortMinConfidence: 0.55,
      shortThresholdBuffer: 0.05,
    });
    mockPortfolio = {
      totalValue: 10000,
      positions: [],
      cash: 10000,
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: 0,
      initialValue: 10000,
    };
  });

  describe('Turnover Control Limits', () => {
    it('should enforce max 8 concurrent entries per cycle', () => {
      riskGate.updateCycle(1);

      // Open 8 positions successfully
      for (let i = 0; i < 8; i++) {
        const decision = createBuyDecision(0.6);
        const result = riskGate.applyGate(`token${i}`, decision, mockPortfolio, goodMarketData());
        expect(result.finalAction).toBe('BUY');
        riskGate.recordPositionOpened(`token${i}`, 'long');
      }

      // 9th position should be rejected
      const decision = createBuyDecision(0.6);
      const result = riskGate.applyGate('token8', decision, mockPortfolio, goodMarketData());
      expect(result.finalAction).toBe('HOLD');
      expect(result.reasons).toContain(expect.stringContaining('TURNOVER_LIMIT'));
    });

    it('should enforce max 2 replacements per cycle', () => {
      riskGate.updateCycle(1);

      // Record some existing positions from previous cycles
      riskGate.recordPositionOpened('token1', 'long');
      riskGate.recordPositionOpened('token2', 'long');

      riskGate.updateCycle(2);

      // Create portfolio with existing positions to trigger replacement logic
      const portfolioWithPositions = {
        ...mockPortfolio,
        positions: [
          {
            tokenId: 'token1',
            symbol: 'TOKEN1',
            side: 'long' as const,
            entryPrice: 100,
            currentPrice: 105,
            quantity: 10,
            entryTimestamp: Date.now() - 86400000, // 1 day ago
            stopLoss: 95,
            takeProfit: 120,
            strategy: 'test',
            pnlPercent: 0.05,
            pnlUsd: 50,
          },
          {
            tokenId: 'token2',
            symbol: 'TOKEN2',
            side: 'long' as const,
            entryPrice: 200,
            currentPrice: 210,
            quantity: 5,
            entryTimestamp: Date.now() - 86400000,
            stopLoss: 190,
            takeProfit: 240,
            strategy: 'test',
            pnlPercent: 0.05,
            pnlUsd: 50,
          },
        ],
      };

      // Replace 2 positions (should succeed)
      for (let i = 0; i < 2; i++) {
        const decision = createBuyDecision(0.6);
        const result = riskGate.applyGate(`token${i + 1}`, decision, portfolioWithPositions, goodMarketData());
        expect(result.finalAction).toBe('BUY');
        riskGate.recordPositionOpened(`token${i + 1}`, 'long', true); // isReplacement = true
      }

      // Add third position to portfolio for replacement test
      const portfolioWithThirdPosition = {
        ...portfolioWithPositions,
        positions: [
          ...portfolioWithPositions.positions,
          {
            tokenId: 'token3',
            symbol: 'TOKEN3',
            side: 'long' as const,
            entryPrice: 300,
            currentPrice: 305,
            quantity: 3,
            entryTimestamp: Date.now() - 86400000,
            stopLoss: 285,
            takeProfit: 360,
            strategy: 'test',
            pnlPercent: 0.017,
            pnlUsd: 15,
          },
        ],
      };

      // 3rd replacement should be rejected
      const decision = createBuyDecision(0.6);
      const result = riskGate.applyGate('token3', decision, portfolioWithThirdPosition, goodMarketData());
      expect(result.finalAction).toBe('HOLD');
      expect(result.reasons).toContain(expect.stringContaining('TURNOVER_LIMIT'));
    });

    it('should enforce minimum 2 cycles hold before flip/close', () => {
      riskGate.updateCycle(1);
      riskGate.recordPositionOpened('bitcoin', 'long');

      // Try to flip on cycle 2 (only 1 cycle held)
      riskGate.updateCycle(2);
      const sellDecision = createSellDecision(-0.4, 0.7);
      let result = riskGate.applyGate('bitcoin', sellDecision, mockPortfolio, goodMarketData(), -0.25);
      expect(result.finalAction).toBe('HOLD');
      expect(result.reasons).toContain(expect.stringContaining('MIN_HOLD_TIME'));

      // Should be allowed on cycle 3 (2 cycles held)
      riskGate.updateCycle(3);
      result = riskGate.applyGate('bitcoin', sellDecision, mockPortfolio, goodMarketData(), -0.25);
      expect(result.finalAction).toBe('SELL');
    });
  });

  describe('Short-side Activation Requirements', () => {
    it('should require confidence >= 0.55 for short entries', () => {
      const lowConfSell = createSellDecision(-0.4, 0.45); // Below 0.55
      const highConfSell = createSellDecision(-0.4, 0.65); // Above 0.55

      let result = riskGate.applyGate('token1', lowConfSell, mockPortfolio, goodMarketData(), -0.25);
      expect(result.finalAction).toBe('HOLD');
      expect(result.shortValidation?.confidencePassed).toBe(false);

      result = riskGate.applyGate('token2', highConfSell, mockPortfolio, goodMarketData(), -0.25);
      expect(result.finalAction).toBe('SELL');
      expect(result.shortValidation?.confidencePassed).toBe(true);
    });

    it('should require score <= sell threshold - 0.05', () => {
      const sellThreshold = -0.30;
      const requiredScore = sellThreshold - 0.05; // -0.35

      const marginallySell = createSellDecision(-0.32, 0.7); // Not far enough
      const strongSell = createSellDecision(-0.40, 0.7); // Far enough

      let result = riskGate.applyGate('token1', marginallySell, mockPortfolio, goodMarketData(), sellThreshold);
      expect(result.finalAction).toBe('HOLD');
      expect(result.shortValidation?.thresholdPassed).toBe(false);

      result = riskGate.applyGate('token2', strongSell, mockPortfolio, goodMarketData(), sellThreshold);
      expect(result.finalAction).toBe('SELL');
      expect(result.shortValidation?.thresholdPassed).toBe(true);
    });

    it('should check notional caps (max 30% short exposure)', () => {
      // Create portfolio with high short exposure
      const portfolioWithShorts: PortfolioState = {
        ...mockPortfolio,
        positions: [
          {
            tokenId: 'token1',
            symbol: 'TOKEN1',
            side: 'short',
            entryPrice: 100,
            currentPrice: 90,
            quantity: 35, // $3500 short exposure (35% of $10k portfolio)
            entryTimestamp: Date.now(),
            stopLoss: 110,
            takeProfit: 80,
            strategy: 'test',
            pnlPercent: 0.1,
            pnlUsd: 350,
          },
        ],
      };

      const sellDecision = createSellDecision(-0.4, 0.7);
      const result = riskGate.applyGate('token2', sellDecision, portfolioWithShorts, goodMarketData(), -0.25);

      expect(result.finalAction).toBe('HOLD');
      expect(result.shortValidation?.notionalCapsPassed).toBe(false);
    });
  });

  describe('Counter Tracking', () => {
    it('should accurately count longs and shorts opened', () => {
      riskGate.updateCycle(1);

      // Open 3 longs and 2 shorts
      riskGate.recordPositionOpened('long1', 'long');
      riskGate.recordPositionOpened('long2', 'long');
      riskGate.recordPositionOpened('long3', 'long');
      riskGate.recordPositionOpened('short1', 'short');
      riskGate.recordPositionOpened('short2', 'short');

      const counters = riskGate.getCycleCounters();
      expect(counters.longsOpened).toBe(3);
      expect(counters.shortsOpened).toBe(2);
    });

    it('should reset counters each cycle', () => {
      riskGate.updateCycle(1);
      riskGate.recordPositionOpened('token1', 'long');
      riskGate.recordPositionOpened('token2', 'short');

      expect(riskGate.getCycleCounters().longsOpened).toBe(1);
      expect(riskGate.getCycleCounters().shortsOpened).toBe(1);

      riskGate.updateCycle(2);

      expect(riskGate.getCycleCounters().longsOpened).toBe(0);
      expect(riskGate.getCycleCounters().shortsOpened).toBe(0);
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle multiple gating conditions', () => {
      // High volatility + low confidence + insufficient liquidity
      const problematicDecision = createBuyDecision(0.3); // Low confidence
      const badMarketData = {
        volatility: 0.2, // High volatility
        volume24hUsd: 50000, // Low volume
        marketCapUsd: 5_000_000, // Low market cap
      };

      const result = riskGate.applyGate('token1', problematicDecision, mockPortfolio, badMarketData);

      expect(result.finalAction).toBe('HOLD');
      expect(result.wasGated).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(1);
    });

    it('should prioritize hard veto over downgrade', () => {
      // Test that confidence veto happens before other downgrades
      const lowConfDecision = createBuyDecision(0.3); // Will trigger confidence veto
      const highVolData = { volatility: 0.15 }; // Would trigger vol downgrade

      const result = riskGate.applyGate('token1', lowConfDecision, mockPortfolio, highVolData);

      expect(result.finalAction).toBe('HOLD');
      expect(result.reasons.some(r => r.includes('BUY_CONFIDENCE_VETO'))).toBe(true);
    });
  });
});

// Helper functions
function createBuyDecision(confidence: number): TradeDecision {
  return {
    action: 'BUY',
    score: 0.5,
    signals: [],
    reasoning: 'test buy',
    confidence,
    timestamp: Date.now(),
  };
}

function createSellDecision(score: number, confidence: number): TradeDecision {
  return {
    action: 'SELL',
    score,
    signals: [],
    reasoning: 'test sell',
    confidence,
    timestamp: Date.now(),
  };
}

function goodMarketData() {
  return {
    bid: 100,
    ask: 100.5,
    volume24hUsd: 5_000_000,
    marketCapUsd: 500_000_000,
    volatility: 0.05,
  };
}