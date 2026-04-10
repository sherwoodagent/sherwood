/**
 * Unit tests for RiskManager — position sizing, drawdown limits, exit checks.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RiskManager, type Position, type RiskConfig } from "./risk.js";

// Helper to create a minimal Position for tests
function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    tokenId: "ethereum",
    symbol: "ETH",
    entryPrice: 2000,
    currentPrice: 2000,
    quantity: 1,
    entryTimestamp: Date.now(),
    stopLoss: 1800,
    takeProfit: 2400,
    strategy: "momentum",
    pnlPercent: 0,
    pnlUsd: 0,
    ...overrides,
  };
}

describe("RiskManager", () => {
  let rm: RiskManager;

  beforeEach(() => {
    rm = new RiskManager();
  });

  // ── canOpenPosition ──

  describe("canOpenPosition", () => {
    it("allows position when within all limits", () => {
      rm.updatePortfolio({ totalValue: 10000, cash: 10000, positions: [] });
      const result = rm.canOpenPosition("bitcoin", 500);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("rejects when max concurrent trades reached", () => {
      const positions = Array.from({ length: 8 }, (_, i) =>
        makePosition({ tokenId: `token-${i}`, symbol: `T${i}` }),
      );
      rm.updatePortfolio({
        totalValue: 100000,
        cash: 50000,
        positions,
      });
      const result = rm.canOpenPosition("newtoken", 500);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Max concurrent trades/);
    });

    it("rejects when single position size exceeds limit", () => {
      rm.updatePortfolio({ totalValue: 10000, cash: 10000, positions: [] });
      // Default maxSinglePosition is 10%, so 1500 on 10000 = 15% > 10%
      const result = rm.canOpenPosition("bitcoin", 1500);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/exceeds max/);
    });

    it("rejects when insufficient cash", () => {
      rm.updatePortfolio({ totalValue: 10000, cash: 200, positions: [] });
      const result = rm.canOpenPosition("bitcoin", 500);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Insufficient cash/);
    });

    it("rejects when duplicate token already held", () => {
      const existingPos = makePosition({ tokenId: "bitcoin", symbol: "BTC" });
      rm.updatePortfolio({
        totalValue: 50000,
        cash: 40000,
        positions: [existingPos],
      });
      const result = rm.canOpenPosition("bitcoin", 500);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Already have an open position/);
    });

    it("rejects when drawdown limit is hit", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 10000,
        positions: [],
        dailyPnl: -600, // 6% daily loss > 5% limit
      });
      const result = rm.canOpenPosition("bitcoin", 500);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/loss limit/i);
    });
  });

  // ── calculatePositionSize ──

  describe("calculatePositionSize", () => {
    it("calculates correct quantity and size from risk formula", () => {
      // riskPerTrade default = 0.02 (2%), maxSinglePosition = 0.10 (10%)
      // portfolioValue = 10000, riskUsd = 200
      // entry = 100, stop = 90, riskPerUnit = 10
      // quantity = 200 / 10 = 20, sizeUsd = 20 * 100 = 2000
      // BUT maxSinglePosition = 10% of 10000 = 1000, so capped:
      // cappedQuantity = 1000 / 100 = 10, sizeUsd = 1000, riskUsd = 10 * 10 = 100
      const result = rm.calculatePositionSize(100, 90, 10000);
      expect(result.quantity).toBeCloseTo(10, 6);
      expect(result.sizeUsd).toBeCloseTo(1000, 6);
      expect(result.riskUsd).toBeCloseTo(100, 6);
    });

    it("caps position size at maxSinglePosition", () => {
      // entry = 100, stop = 99.5, riskPerUnit = 0.5
      // riskUsd = 10000 * 0.02 = 200, quantity = 200 / 0.5 = 400
      // sizeUsd = 400 * 100 = 40000, but maxSinglePosition = 10% of 10000 = 1000
      const result = rm.calculatePositionSize(100, 99.5, 10000);
      expect(result.sizeUsd).toBeCloseTo(1000, 6);
      expect(result.quantity).toBeCloseTo(10, 6);
      // riskUsd should be recalculated: 10 * 0.5 = 5
      expect(result.riskUsd).toBeCloseTo(5, 6);
    });

    it("returns zero for zero entry price", () => {
      const result = rm.calculatePositionSize(0, 90, 10000);
      expect(result.quantity).toBe(0);
      expect(result.sizeUsd).toBe(0);
      expect(result.riskUsd).toBe(0);
    });

    it("returns zero for zero portfolio value", () => {
      const result = rm.calculatePositionSize(100, 90, 0);
      expect(result.quantity).toBe(0);
      expect(result.sizeUsd).toBe(0);
      expect(result.riskUsd).toBe(0);
    });

    it("returns zero when entry equals stop loss (zero risk per unit)", () => {
      const result = rm.calculatePositionSize(100, 100, 10000);
      expect(result.quantity).toBe(0);
      expect(result.sizeUsd).toBe(0);
    });

    it("respects custom maxRiskPercent override", () => {
      // override riskPerTrade to 5%
      // riskUsd = 10000 * 0.05 = 500, riskPerUnit = 10
      // quantity = 500 / 10 = 50, sizeUsd = 50 * 100 = 5000
      // but maxSinglePosition = 10% of 10000 = 1000 => capped
      const result = rm.calculatePositionSize(100, 90, 10000, 0.05);
      expect(result.sizeUsd).toBeCloseTo(1000, 6);
    });
  });

  // ── isDrawdownLimitHit ──

  describe("isDrawdownLimitHit", () => {
    it("returns not paused when within all limits", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 9000,
        positions: [],
        dailyPnl: -100, // 1% < 5% limit
        weeklyPnl: -500, // 5% < 10% limit
        monthlyPnl: -800, // 8% < 15% limit
      });
      const result = rm.isDrawdownLimitHit();
      expect(result.paused).toBe(false);
      expect(result.level).toBeNull();
    });

    it("pauses when daily loss exceeds limit", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 9500,
        positions: [],
        dailyPnl: -600, // 6% > 5% daily limit
        weeklyPnl: 0,
        monthlyPnl: 0,
      });
      const result = rm.isDrawdownLimitHit();
      expect(result.paused).toBe(true);
      expect(result.level).toBe("daily");
      expect(result.message).toMatch(/Daily loss limit/);
    });

    it("pauses when weekly loss exceeds limit", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 9000,
        positions: [],
        dailyPnl: -100, // 1% — within daily
        weeklyPnl: -1100, // 11% > 10% weekly limit
        monthlyPnl: 0,
      });
      const result = rm.isDrawdownLimitHit();
      expect(result.paused).toBe(true);
      expect(result.level).toBe("weekly");
    });

    it("pauses when monthly loss exceeds limit", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 8000,
        positions: [],
        dailyPnl: -100,
        weeklyPnl: -500,
        monthlyPnl: -1600, // 16% > 15% monthly limit
      });
      const result = rm.isDrawdownLimitHit();
      expect(result.paused).toBe(true);
      expect(result.level).toBe("monthly");
    });

    it("does not pause for positive PnL even if large", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 9000,
        positions: [],
        dailyPnl: 5000, // +50% gain — not a loss
        weeklyPnl: 5000,
        monthlyPnl: 5000,
      });
      const result = rm.isDrawdownLimitHit();
      expect(result.paused).toBe(false);
    });

    it("does not pause when portfolio value is zero", () => {
      rm.updatePortfolio({
        totalValue: 0,
        cash: 0,
        positions: [],
        dailyPnl: -100,
      });
      const result = rm.isDrawdownLimitHit();
      expect(result.paused).toBe(false);
      expect(result.message).toMatch(/No portfolio value/);
    });
  });

  // ── checkExits ──

  describe("checkExits", () => {
    it("triggers stop loss when price drops below stop", () => {
      const pos = makePosition({
        tokenId: "bitcoin",
        entryPrice: 50000,
        stopLoss: 47000,
        takeProfit: 55000,
      });
      const result = rm.checkExits([pos], { bitcoin: 46500 });
      expect(result.toClose).toHaveLength(1);
      expect(result.toClose[0]!.tokenId).toBe("bitcoin");
      expect(result.reasons["bitcoin"]).toMatch(/Stop loss hit/);
    });

    it("triggers take profit when price exceeds target", () => {
      const pos = makePosition({
        tokenId: "bitcoin",
        entryPrice: 50000,
        stopLoss: 47000,
        takeProfit: 55000,
      });
      const result = rm.checkExits([pos], { bitcoin: 56000 });
      expect(result.toClose).toHaveLength(1);
      expect(result.reasons["bitcoin"]).toMatch(/Take profit hit/);
    });

    it("triggers hard stop when loss exceeds hardStopPercent", () => {
      // Default hardStopPercent is 0.12 (12%)
      const pos = makePosition({
        tokenId: "bitcoin",
        entryPrice: 50000,
        stopLoss: 40000, // wide stop so we hit hard stop first
        takeProfit: 60000,
      });
      // Price at 43000 => pnl = (43000-50000)/50000 = -14% > -12%
      const result = rm.checkExits([pos], { bitcoin: 43000 });
      expect(result.toClose).toHaveLength(1);
      expect(result.reasons["bitcoin"]).toMatch(/Hard stop hit/);
    });

    it("triggers time-based exit after 7 days with low PnL", () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const pos = makePosition({
        tokenId: "bitcoin",
        entryPrice: 50000,
        stopLoss: 45000,
        takeProfit: 60000,
        entryTimestamp: eightDaysAgo,
      });
      // Price at 50500 => pnl = +1%, which is < 2% threshold
      const result = rm.checkExits([pos], { bitcoin: 50500 });
      expect(result.toClose).toHaveLength(1);
      expect(result.reasons["bitcoin"]).toMatch(/Time stop/);
    });

    it("does not exit position within normal range", () => {
      const pos = makePosition({
        tokenId: "bitcoin",
        entryPrice: 50000,
        stopLoss: 47000,
        takeProfit: 55000,
        entryTimestamp: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days old
      });
      // Price at 51000 — within all limits
      const result = rm.checkExits([pos], { bitcoin: 51000 });
      expect(result.toClose).toHaveLength(0);
      expect(Object.keys(result.reasons)).toHaveLength(0);
    });

    it("ignores positions for which no price is available", () => {
      const pos = makePosition({ tokenId: "bitcoin" });
      const result = rm.checkExits([pos], { ethereum: 2000 });
      expect(result.toClose).toHaveLength(0);
    });

    it("triggers trailing stop when set and price falls below it", () => {
      const pos = makePosition({
        tokenId: "bitcoin",
        entryPrice: 50000,
        stopLoss: 47000,
        takeProfit: 60000,
        trailingStop: 52000,
      });
      // Price at 51500 — below trailing stop of 52000 but above hard stop
      const result = rm.checkExits([pos], { bitcoin: 51500 });
      expect(result.toClose).toHaveLength(1);
      expect(result.reasons["bitcoin"]).toMatch(/Trailing stop hit/);
    });

    it("handles multiple positions and only exits qualifying ones", () => {
      const pos1 = makePosition({
        tokenId: "bitcoin",
        entryPrice: 50000,
        stopLoss: 47000,
        takeProfit: 55000,
      });
      const pos2 = makePosition({
        tokenId: "ethereum",
        symbol: "ETH",
        entryPrice: 2000,
        stopLoss: 1800,
        takeProfit: 2500,
      });
      // bitcoin hits take profit, ethereum is fine
      const result = rm.checkExits(
        [pos1, pos2],
        { bitcoin: 56000, ethereum: 2100 },
      );
      expect(result.toClose).toHaveLength(1);
      expect(result.toClose[0]!.tokenId).toBe("bitcoin");
    });
  });

  // ── Custom config ──

  describe("custom config", () => {
    it("respects custom maxConcurrentTrades", () => {
      const custom = new RiskManager({ maxConcurrentTrades: 2 });
      const positions = [
        makePosition({ tokenId: "a", symbol: "A" }),
        makePosition({ tokenId: "b", symbol: "B" }),
      ];
      custom.updatePortfolio({ totalValue: 100000, cash: 50000, positions });
      const result = custom.canOpenPosition("c", 500);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Max concurrent trades \(2\)/);
    });

    it("respects custom dailyLossLimit", () => {
      const custom = new RiskManager({ dailyLossLimit: 0.01 }); // 1%
      custom.updatePortfolio({
        totalValue: 10000,
        cash: 10000,
        positions: [],
        dailyPnl: -150, // 1.5% > 1%
      });
      const result = custom.isDrawdownLimitHit();
      expect(result.paused).toBe(true);
      expect(result.level).toBe("daily");
    });
  });
});
