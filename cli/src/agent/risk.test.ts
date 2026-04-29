/**
 * Unit tests for RiskManager — position sizing, drawdown limits, exit checks.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RiskManager, DEFAULT_RISK_CONFIG, RECOMMENDED_TRAILING_CONFIG, MAX_PYRAMID_ADDS, PYRAMID_MIN_SPACING_MS, STOP_COOLDOWN_MS, TOKEN_CONSEC_LOSS_LIMIT, TOKEN_LOSS_COOLDOWN_MS, type Position, type RiskConfig } from "./risk.js";

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
      // maxSinglePosition is 55%, so 6000 on 10000 = 60% > 55%
      const result = rm.canOpenPosition("bitcoin", 6000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/exceeds max/);
    });

    it("rejects when insufficient cash (margin)", () => {
      rm.updatePortfolio({ totalValue: 10000, cash: 100, positions: [] });
      // $1000 × 33% margin = $330, but only $100 cash
      const result = rm.canOpenPosition("bitcoin", 1000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Insufficient cash/);
    });

    it("rejects pyramid add when spacing not met (within 4h of prior fill)", () => {
      // Existing long opened just now — should be inside the spacing window
      const existingPos = makePosition({
        tokenId: "bitcoin",
        symbol: "BTC",
        side: "long",
        addCount: 0,
        lastAddTimestamp: Date.now(),
      });
      rm.updatePortfolio({
        totalValue: 50000,
        cash: 40000,
        positions: [existingPos],
      });
      const result = rm.canOpenPosition("bitcoin", 500, "long");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Pyramid spacing/);
    });

    it("rejects pyramid when MAX_PYRAMID_ADDS already reached", () => {
      const existingPos = makePosition({
        tokenId: "bitcoin",
        symbol: "BTC",
        side: "long",
        addCount: MAX_PYRAMID_ADDS,
        lastAddTimestamp: Date.now() - PYRAMID_MIN_SPACING_MS - 1000, // spacing OK
      });
      rm.updatePortfolio({
        totalValue: 50000,
        cash: 40000,
        positions: [existingPos],
      });
      const result = rm.canOpenPosition("bitcoin", 500, "long");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Pyramid cap reached/);
    });

    it("allows pyramid add when below cap and past spacing window", () => {
      const existingPos = makePosition({
        tokenId: "bitcoin",
        symbol: "BTC",
        side: "long",
        addCount: 0,
        lastAddTimestamp: Date.now() - PYRAMID_MIN_SPACING_MS - 1000,
      });
      rm.updatePortfolio({
        totalValue: 50000,
        cash: 40000,
        positions: [existingPos],
      });
      const result = rm.canOpenPosition("bitcoin", 500, "long");
      expect(result.allowed).toBe(true);
    });

    it("rejects opposite-direction add (no flip via pyramid)", () => {
      const existingPos = makePosition({
        tokenId: "bitcoin",
        symbol: "BTC",
        side: "long",
        addCount: 0,
        lastAddTimestamp: Date.now() - PYRAMID_MIN_SPACING_MS - 1000,
      });
      rm.updatePortfolio({
        totalValue: 50000,
        cash: 40000,
        positions: [existingPos],
      });
      const result = rm.canOpenPosition("bitcoin", 500, "short");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Conflicting position/);
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

    it("rejects entry during post-stop cooldown", () => {
      rm.updatePortfolio({
        totalValue: 50000,
        cash: 40000,
        positions: [],
        stopCooldowns: { bitcoin: Date.now() - 1000 }, // stopped 1 sec ago
      });
      const result = rm.canOpenPosition("bitcoin", 500, "long");
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Stop cooldown/);
    });

    it("allows entry after stop cooldown expires", () => {
      rm.updatePortfolio({
        totalValue: 50000,
        cash: 40000,
        positions: [],
        stopCooldowns: { bitcoin: Date.now() - STOP_COOLDOWN_MS - 1000 }, // 4h+ ago
      });
      const result = rm.canOpenPosition("bitcoin", 500, "long");
      expect(result.allowed).toBe(true);
    });
  });

  // ── calculatePositionSize ──

  describe("calculatePositionSize", () => {
    it("calculates correct quantity and size from risk formula", () => {
      // riskPerTrade default = 0.02 (2%), maxSinglePosition = 0.55 (55%)
      // portfolioValue = 10000, riskUsd = 200
      // entry = 100, stop = 90, riskPerUnit = 10
      // quantity = 200 / 10 = 20, sizeUsd = 20 * 100 = 2000
      // maxSinglePosition = 55% of 10000 = 5500 → NOT capped (2000 < 5500)
      const result = rm.calculatePositionSize(100, 90, 10000);
      expect(result.quantity).toBeCloseTo(20, 6);
      expect(result.sizeUsd).toBeCloseTo(2000, 6);
      expect(result.riskUsd).toBeCloseTo(200, 6);
    });

    it("caps position size at maxSinglePosition", () => {
      // entry = 100, stop = 99.5, riskPerUnit = 0.5
      // riskUsd = 10000 * 0.02 = 200, quantity = 200 / 0.5 = 400
      // sizeUsd = 400 * 100 = 40000, but maxSinglePosition = 55% of 10000 = 5500
      const result = rm.calculatePositionSize(100, 99.5, 10000);
      expect(result.sizeUsd).toBeCloseTo(5500, 6);
      expect(result.quantity).toBeCloseTo(55, 6);
      // riskUsd should be recalculated: 55 * 0.5 = 27.5
      expect(result.riskUsd).toBeCloseTo(27.5, 6);
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
      // maxSinglePosition = 55% of 10000 = 5500 → NOT capped (5000 < 5500)
      const result = rm.calculatePositionSize(100, 90, 10000, 0.05);
      expect(result.sizeUsd).toBeCloseTo(5000, 6);
    });

    it("clamps to maxSinglePosition when size exceeds cap", () => {
      // Very high risk override to force capping.
      // riskUsd = 10000 * 0.10 = 1000, riskPerUnit = 10
      // quantity = 100, sizeUsd = 10000 → capped at 55% = 5500
      const result = rm.calculatePositionSize(100, 90, 10000, 0.10);
      expect(result.sizeUsd).toBeLessThanOrEqual(5500);
      expect(result.sizeUsd).toBeCloseTo(5500, 6);
    });
  });

  // ── getRiskPerTrade ──

  describe("getRiskPerTrade", () => {
    it("exposes the configured base risk fraction", () => {
      expect(rm.getRiskPerTrade()).toBe(0.02);
      const custom = new RiskManager({ riskPerTrade: 0.015 });
      expect(custom.getRiskPerTrade()).toBe(0.015);
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
        stopLoss: 49000, // 2% stop — within the 5% hard stop
        takeProfit: 53000,
      });
      const result = rm.checkExits([pos], { bitcoin: 48900 }); // below 49000 stop
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

    it("triggers time-based exit after 96h with low PnL", () => {
      const fiveDaysAgo = Date.now() - 5 * 24 * 60 * 60 * 1000;
      const pos = makePosition({
        tokenId: "bitcoin",
        entryPrice: 50000,
        stopLoss: 48500,
        takeProfit: 53000,
        entryTimestamp: fiveDaysAgo,
      });
      // Price at 50200 => pnl = +0.4%, which is < 1% threshold
      const result = rm.checkExits([pos], { bitcoin: 50200 });
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

  describe("updateTrailingStops", () => {
    // Trailing defaults are OFF. Use the recommended preset for these tests.
    let trailingRm: RiskManager;
    beforeEach(() => {
      trailingRm = new RiskManager({
        ...DEFAULT_RISK_CONFIG,
        trailingStopPct: RECOMMENDED_TRAILING_CONFIG.trailingStopPct,
        breakevenTriggerPct: RECOMMENDED_TRAILING_CONFIG.breakevenTriggerPct,
        profitLockSteps: [...RECOMMENDED_TRAILING_CONFIG.profitLockSteps],
      });
    });

    it("applies trailing/breakeven/profit-lock with default risk config (ON by default)", () => {
      const pos = makePosition({
        entryPrice: 100,
        currentPrice: 150,        // +50% gain
        stopLoss: 90,
      });
      // rm uses DEFAULT_RISK_CONFIG — trailing is now ON by default.
      // HWM: peak=150, highest-triggered tier (+20%) → 100 + (150-100)*0.85 = 142.50.
      // Percent-trail: 150 × (1 - 0.03) = 145.50. Trail wins (higher stop).
      const [updated] = rm.updateTrailingStops([pos]);
      expect(updated!.stopLoss).toBe(145.5);
    });

    it("moves stop to breakeven after +1.5% gain", () => {
      const pos = makePosition({
        entryPrice: 100,
        currentPrice: 102, // +2% triggers breakeven (1.5%) but no HWM tier (first is +5%)
        stopLoss: 97,
      });
      const [updated] = trailingRm.updateTrailingStops([pos]);
      // breakeven → 100; percent-trail 3% → 102*0.97=98.94; max = 100
      expect(updated!.stopLoss).toBe(100);
    });

    it("HWM locks 30% of peak move after +5% gain", () => {
      const pos = makePosition({
        entryPrice: 100,
        currentPrice: 105,   // +5% triggers first HWM tier (lockPct=0.30)
        stopLoss: 97,
      });
      const [updated] = trailingRm.updateTrailingStops([pos]);
      // This test uses trailingRm with RECOMMENDED_TRAILING_CONFIG (4% trail, 2% breakeven).
      // peak=105, lock = 100 + (105-100)*0.30 = 101.50
      // breakeven → 100; percent-trail 105*0.96 = 100.80
      // max(97, 100, 101.50, 100.80) = 101.50 (HWM lock wins)
      expect(updated!.stopLoss).toBeCloseTo(101.50, 2);
      expect(updated!.peakPrice).toBe(105);
    });

    it("HWM locks 50% of peak move after +10% gain", () => {
      const pos = makePosition({
        entryPrice: 100,
        currentPrice: 110,   // +10% triggers tiers at 5% and 10%
        stopLoss: 97,
      });
      const [updated] = trailingRm.updateTrailingStops([pos]);
      // peak=110; +10% tier (lockPct=0.50) → 100 + 10*0.50 = 105.
      // percent-trail 110*0.96 = 105.60. Trail wins (105.60 > 105).
      expect(updated!.stopLoss).toBeCloseTo(105.60, 2);
    });

    it("percent-trail beats HWM lock at large gains", () => {
      const pos = makePosition({
        entryPrice: 100,
        currentPrice: 115,   // +15% → tier lockPct=0.70
        stopLoss: 97,
      });
      const [updated] = trailingRm.updateTrailingStops([pos]);
      // HWM lock = 100 + 15*0.70 = 110.50. Trail = 115*0.96 = 110.40. HWM lock wins.
      expect(updated!.stopLoss).toBeCloseTo(110.50, 2);
    });

    it("never moves stop down (peak updates but stopLoss pinned)", () => {
      const pos = makePosition({
        entryPrice: 100,
        currentPrice: 101,
        stopLoss: 99,        // already above current trail (101*0.975=98.475) and no tier fires
      });
      const [updated] = trailingRm.updateTrailingStops([pos]);
      // stop stays at 99 (no tier triggered, breakeven at +1.5% not reached,
      // trail lower than current stop). Peak gets updated to 101 for future cycles.
      expect(updated!.stopLoss).toBe(99);
    });

    it("respects disabled mechanisms", () => {
      const mgrNoMechs = new RiskManager({
        ...DEFAULT_RISK_CONFIG,
        trailingStopPct: 0,
        breakevenTriggerPct: 0,
        profitLockSteps: [],
      });
      const pos = makePosition({
        entryPrice: 100,
        currentPrice: 150,
        stopLoss: 90,
      });
      const [updated] = mgrNoMechs.updateTrailingStops([pos]);
      expect(updated!.stopLoss).toBe(90);
    });

    it("writes to trailingStop field as well as stopLoss", () => {
      const pos = makePosition({
        entryPrice: 100,
        currentPrice: 110,
        stopLoss: 90,
        trailingStop: undefined,
      });
      const [updated] = trailingRm.updateTrailingStops([pos]);
      expect(updated!.trailingStop).toBeDefined();
      expect(updated!.trailingStop).toBe(updated!.stopLoss);
    });
  });

  describe("updateStopLosses (ATR trailing)", () => {
    // Use trailingStopAtr=2 so arithmetic matches the spec for this bug fix.
    let atrRm: RiskManager;
    beforeEach(() => {
      atrRm = new RiskManager({ ...DEFAULT_RISK_CONFIG, trailingStopAtr: 2 });
    });

    it("LONG: tightens trailing stop up toward current price", () => {
      const pos = makePosition({
        entryPrice: 100,
        currentPrice: 110,
        stopLoss: 97,
      });
      // candidate = 110 - 2*1 = 108 > 97 → tighten.
      const [updated] = atrRm.updateStopLosses([pos], { ethereum: 1 });
      expect(updated!.trailingStop).toBe(108);
      expect(updated!.stopLoss).toBe(108);
    });

    it("LONG: never moves stop down", () => {
      const pos = makePosition({
        entryPrice: 100,
        currentPrice: 110,
        stopLoss: 109,
      });
      // candidate = 108 < 109 → no change.
      const [updated] = atrRm.updateStopLosses([pos], { ethereum: 1 });
      expect(updated).toBe(pos);
    });

    it("SHORT: tightens trailing stop DOWN toward current price", () => {
      // entry $100, stop $103, price $90, atr $1, trailingStopAtr=2 → new trail = 92
      const pos = makePosition({
        side: "short",
        entryPrice: 100,
        currentPrice: 90,
        stopLoss: 103,
      });
      const [updated] = atrRm.updateStopLosses([pos], { ethereum: 1 });
      expect(updated!.trailingStop).toBe(92);
      expect(updated!.stopLoss).toBe(92);
    });

    it("SHORT: never moves stop up (loosen)", () => {
      // candidate = 90 + 2 = 92; current trailing = 91 → 92 > 91, so no tighten.
      const pos = makePosition({
        side: "short",
        entryPrice: 100,
        currentPrice: 90,
        stopLoss: 91,
      });
      const [updated] = atrRm.updateStopLosses([pos], { ethereum: 1 });
      expect(updated).toBe(pos);
    });

    it("SHORT: pins stopLoss to tighter (LOWER) via Math.min", () => {
      const pos = makePosition({
        side: "short",
        entryPrice: 100,
        currentPrice: 90,
        stopLoss: 95,
      });
      const [updated] = atrRm.updateStopLosses([pos], { ethereum: 1 });
      // candidate 92 < currentTrailing 95 → tighten; stopLoss = min(95, 92) = 92
      expect(updated!.trailingStop).toBe(92);
      expect(updated!.stopLoss).toBe(92);
    });
  });

  // ── Orca-inspired: PnL-aware daily cap ──
  describe("getDynamicDailyCap", () => {
    it("returns 12 at >= +5% daily PnL (hot hand)", () => {
      rm.updatePortfolio({
        totalValue: 10500,
        cash: 10500,
        positions: [],
        dailyPnl: 500, // +5%
      });
      expect(rm.getDynamicDailyCap()).toBe(12);
    });

    it("returns 8 for [0%, +5%) daily PnL", () => {
      rm.updatePortfolio({
        totalValue: 10300,
        cash: 10300,
        positions: [],
        dailyPnl: 300, // +3%
      });
      expect(rm.getDynamicDailyCap()).toBe(8);
    });

    it("returns 5 for [-5%, 0%) daily PnL", () => {
      rm.updatePortfolio({
        totalValue: 9700,
        cash: 9700,
        positions: [],
        dailyPnl: -300, // -3%
      });
      expect(rm.getDynamicDailyCap()).toBe(5);
    });

    it("returns 3 for [-15%, -5%) daily PnL", () => {
      rm.updatePortfolio({
        totalValue: 9000,
        cash: 9000,
        positions: [],
        dailyPnl: -1000, // -10%
      });
      expect(rm.getDynamicDailyCap()).toBe(3);
    });

    it("returns 1 for [-25%, -15%) daily PnL", () => {
      rm.updatePortfolio({
        totalValue: 8000,
        cash: 8000,
        positions: [],
        dailyPnl: -2000, // -20%
      });
      expect(rm.getDynamicDailyCap()).toBe(1);
    });

    it("returns 0 at < -25% daily PnL (circuit breaker)", () => {
      rm.updatePortfolio({
        totalValue: 7000,
        cash: 7000,
        positions: [],
        dailyPnl: -3000, // -30%
      });
      expect(rm.getDynamicDailyCap()).toBe(0);
    });

    it("boundary: exactly +5% returns 12 (inclusive lower bound of top tier)", () => {
      rm.updatePortfolio({
        totalValue: 10500,
        cash: 10500,
        positions: [],
        dailyPnl: 500, // exactly +5%
      });
      expect(rm.getDynamicDailyCap()).toBe(12);
    });

    it("boundary: exactly 0% returns 8 (non-negative side)", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 10000,
        positions: [],
        dailyPnl: 0,
      });
      expect(rm.getDynamicDailyCap()).toBe(8);
    });

    it("respects dailyCapOverride and short-circuits tiers", () => {
      const custom = new RiskManager({ dailyCapOverride: 3 });
      custom.updatePortfolio({
        totalValue: 15000,
        cash: 15000,
        positions: [],
        dailyPnl: 5000, // +50% — would normally return 12
      });
      expect(custom.getDynamicDailyCap()).toBe(3);
    });

    it("falls back to middle tier (5) when start-of-day value cannot be derived", () => {
      rm.updatePortfolio({
        totalValue: 0,
        cash: 0,
        positions: [],
        dailyPnl: 0,
      });
      expect(rm.getDynamicDailyCap()).toBe(5);
    });
  });

  describe("canOpenPosition + dynamic daily cap", () => {
    it("blocks new entry when daily-entry count reaches the dynamic cap", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 10000,
        positions: [],
        dailyPnl: 0,          // → cap = 8
        dailyEntries: 8,
      });
      const result = rm.canOpenPosition("bitcoin", 500);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Dynamic daily cap \(8\)/);
    });

    it("allows new entry up to (cap - 1)", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 10000,
        positions: [],
        dailyPnl: 0,
        dailyEntries: 7, // still under cap of 8
      });
      const result = rm.canOpenPosition("bitcoin", 500);
      expect(result.allowed).toBe(true);
    });

    it("pyramid adds to an existing position DO NOT count against the cap", () => {
      // dailyEntries already at cap (8) — a pyramid add should still be
      // checked against pyramid rules, not the daily-turnover budget.
      const existingPos = makePosition({
        tokenId: "bitcoin",
        symbol: "BTC",
        side: "long",
        addCount: 0,
        lastAddTimestamp: Date.now() - PYRAMID_MIN_SPACING_MS - 1000,
      });
      rm.updatePortfolio({
        totalValue: 50000,
        cash: 40000,
        positions: [existingPos],
        dailyPnl: 0,
        dailyEntries: 8, // would block a NEW token — shouldn't block this add
      });
      const result = rm.canOpenPosition("bitcoin", 500, "long");
      expect(result.allowed).toBe(true);
    });

    it("circuit breaker: at < -25% PnL no new entry is allowed", () => {
      rm.updatePortfolio({
        totalValue: 7000,
        cash: 7000,
        positions: [],
        dailyPnl: -3000, // -30%
        dailyEntries: 0,
      });
      // But daily-loss guard at -5% also fires — check the message carefully.
      // isDrawdownLimitHit runs AFTER the dynamic-cap check in canOpenPosition,
      // so the cap-zero message should surface first for NEW entries.
      const result = rm.canOpenPosition("bitcoin", 500);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Dynamic daily cap \(0\)/);
    });

    it("respects dailyCapOverride in the entry-cap check", () => {
      const custom = new RiskManager({ dailyCapOverride: 2 });
      custom.updatePortfolio({
        totalValue: 10000,
        cash: 10000,
        positions: [],
        dailyPnl: 0,
        dailyEntries: 2,
      });
      const result = custom.canOpenPosition("bitcoin", 500);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/Dynamic daily cap \(2\)/);
    });
  });

  // ── Orca-inspired: HWM profit-lock ──
  describe("updateTrailingStops HWM semantics", () => {
    let hwmRm: RiskManager;
    beforeEach(() => {
      hwmRm = new RiskManager(DEFAULT_RISK_CONFIG);
    });

    it("LONG: tracks peak price across cycles", () => {
      // Cycle 1: price hits 110 (+10%)
      const pos1 = makePosition({ entryPrice: 100, currentPrice: 110, stopLoss: 97 });
      const [afterCycle1] = hwmRm.updateTrailingStops([pos1]);
      expect(afterCycle1!.peakPrice).toBe(110);

      // Cycle 2: price retraces to 108 — peak must not drop
      const pos2 = { ...afterCycle1!, currentPrice: 108 };
      const [afterCycle2] = hwmRm.updateTrailingStops([pos2]);
      expect(afterCycle2!.peakPrice).toBe(110);

      // Cycle 3: price makes a new peak at 115 — peak advances
      const pos3 = { ...afterCycle2!, currentPrice: 115 };
      const [afterCycle3] = hwmRm.updateTrailingStops([pos3]);
      expect(afterCycle3!.peakPrice).toBe(115);
    });

    it("LONG: lock ratchets UP with new peaks, never down on retrace", () => {
      // Cycle 1: +10% → lockPct 0.50 applied on peak=110.
      const pos1 = makePosition({ entryPrice: 100, currentPrice: 110, stopLoss: 97 });
      const [c1] = hwmRm.updateTrailingStops([pos1]);
      const lockAfterC1 = c1!.stopLoss;
      // 100 + 10*0.50 = 105 vs trail 110*0.97 = 106.7 → 106.7 (trail wins with 3%)
      expect(lockAfterC1).toBeCloseTo(106.7, 2);

      // Cycle 2: retrace to 108 (still +8%). stopLoss must NOT decrease.
      const pos2 = { ...c1!, currentPrice: 108 };
      const [c2] = hwmRm.updateTrailingStops([pos2]);
      expect(c2!.stopLoss).toBeGreaterThanOrEqual(lockAfterC1);

      // Cycle 3: new peak at 120 (+20%) — tier 0.85 applies on peak=120.
      // 100 + 20*0.85 = 117. Trail = 120*0.97 = 116.4. Lock wins → 117.
      const pos3 = { ...c2!, currentPrice: 120 };
      const [c3] = hwmRm.updateTrailingStops([pos3]);
      expect(c3!.stopLoss).toBeCloseTo(117, 2);
      expect(c3!.peakPrice).toBe(120);
    });

    it("LONG: each HWM tier locks the correct fraction of peak move", () => {
      const cases: Array<{ price: number; expectedLock: number; desc: string }> = [
        { price: 105, expectedLock: 101.5, desc: "+5%  → 30% of 5 = 1.5" },
        { price: 110, expectedLock: 105,   desc: "+10% → 50% of 10 = 5" },
        { price: 115, expectedLock: 110.5, desc: "+15% → 70% of 15 = 10.5" },
        { price: 120, expectedLock: 117,   desc: "+20% → 85% of 20 = 17" },
      ];
      // Isolate the HWM mechanism — no percent-trail or breakeven interference.
      const hwmOnly = new RiskManager({
        ...DEFAULT_RISK_CONFIG,
        trailingStopPct: 0,
        breakevenTriggerPct: 0,
      });
      for (const c of cases) {
        const pos = makePosition({ entryPrice: 100, currentPrice: c.price, stopLoss: 90 });
        const [updated] = hwmOnly.updateTrailingStops([pos]);
        expect(updated!.stopLoss).toBeCloseTo(c.expectedLock, 2);
      }
    });

    it("SHORT: tracks peak price as the LOWEST price seen (most profit)", () => {
      const pos = makePosition({
        side: "short", entryPrice: 100, currentPrice: 90, stopLoss: 110,
      });
      const [c1] = hwmRm.updateTrailingStops([pos]);
      expect(c1!.peakPrice).toBe(90);

      // Price bounces up to 92 — peak must not rise
      const pos2 = { ...c1!, currentPrice: 92 };
      const [c2] = hwmRm.updateTrailingStops([pos2]);
      expect(c2!.peakPrice).toBe(90);

      // Price makes new low at 85 — peak advances (lower)
      const pos3 = { ...c2!, currentPrice: 85 };
      const [c3] = hwmRm.updateTrailingStops([pos3]);
      expect(c3!.peakPrice).toBe(85);
    });

    it("SHORT: HWM lock ratchets DOWN with new lows, formula mirrors LONG", () => {
      // SHORT at entry 100, price 85 (+15% profit for short → tier lockPct=0.70).
      // stop = entry - (entry - peak) * lockPct = 100 - (100-85)*0.70 = 100 - 10.5 = 89.5
      // Isolate HWM from percent-trail interference.
      const hwmOnly = new RiskManager({
        ...DEFAULT_RISK_CONFIG,
        trailingStopPct: 0,
        breakevenTriggerPct: 0,
      });
      const pos = makePosition({
        side: "short", entryPrice: 100, currentPrice: 85, stopLoss: 110,
      });
      const [updated] = hwmOnly.updateTrailingStops([pos]);
      expect(updated!.stopLoss).toBeCloseTo(89.5, 2);
      expect(updated!.peakPrice).toBe(85);
    });

    it("legacy position without peakPrice seeds from entryPrice and doesn't over-lock", () => {
      // A freshly-loaded position from pre-HWM portfolio.json has no peakPrice.
      // On the first cycle after upgrade, peak seeds from entryPrice — so no
      // HWM tier fires until price actually advances past entry.
      // Isolate HWM semantics from breakeven/percent-trail so this test
      // specifically verifies the legacy migration doesn't over-lock.
      const hwmOnly = new RiskManager({
        ...DEFAULT_RISK_CONFIG,
        trailingStopPct: 0,
        breakevenTriggerPct: 0,
      });
      const legacyPos: Position = makePosition({
        entryPrice: 100,
        currentPrice: 100.5, // barely in the money
        stopLoss: 90,
      });
      // peakPrice intentionally left undefined.
      expect(legacyPos.peakPrice).toBeUndefined();
      const [updated] = hwmOnly.updateTrailingStops([legacyPos]);
      // With peak seeded at 100 and current=100.5, no HWM tier triggers
      // (+5% not reached). stopLoss stays at 90. peakPrice advances to 100.5.
      expect(updated!.peakPrice).toBe(100.5);
      expect(updated!.stopLoss).toBe(90);
    });

    it("legacy position at +10% since entry doesn't over-lock on first post-upgrade cycle", () => {
      // If a pre-HWM position is loaded and price is already +10% from entry,
      // the seeded peak (=entry) means the HWM lock is computed against the
      // NEW observed peak (=current), not a hypothetical historical high.
      // This matches the safe behavior: lock amount = tier(lockPct) × real move.
      const hwmOnly = new RiskManager({
        ...DEFAULT_RISK_CONFIG,
        trailingStopPct: 0,
        breakevenTriggerPct: 0,
      });
      const legacyPos: Position = makePosition({
        entryPrice: 100,
        currentPrice: 110, // +10%
        stopLoss: 95,
      });
      expect(legacyPos.peakPrice).toBeUndefined();
      const [updated] = hwmOnly.updateTrailingStops([legacyPos]);
      // peak seeds at entry(100), then gets updated to 110 this cycle.
      // +10% triggers tiers at 5% and 10% → highest lockPct = 0.50.
      // lock = 100 + (110-100)*0.50 = 105.
      expect(updated!.peakPrice).toBe(110);
      expect(updated!.stopLoss).toBe(105);
    });
  });

  // ── Per-token consecutive loss cooldown ──

  describe("token consecutive loss cooldown", () => {
    it("blocks entry when token has >= TOKEN_CONSEC_LOSS_LIMIT consecutive losses", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 10000,
        positions: [],
        dailyPnl: 0,
        weeklyPnl: 0,
        monthlyPnl: 0,
        tokenConsecLosses: { aave: 2 },
        tokenLossCooldowns: { aave: Date.now() },
      });
      const result = rm.canOpenPosition("aave", 500);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("consecutive losses");
      expect(result.reason).toContain("aave");
    });

    it("allows entry when token has fewer than TOKEN_CONSEC_LOSS_LIMIT losses", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 10000,
        positions: [],
        dailyPnl: 0,
        weeklyPnl: 0,
        monthlyPnl: 0,
        tokenConsecLosses: { aave: 1 },
        tokenLossCooldowns: {},
      });
      const result = rm.canOpenPosition("aave", 500);
      expect(result.allowed).toBe(true);
    });

    it("allows entry when 24h cooldown has expired", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 10000,
        positions: [],
        dailyPnl: 0,
        weeklyPnl: 0,
        monthlyPnl: 0,
        tokenConsecLosses: { aave: 3 },
        tokenLossCooldowns: { aave: Date.now() - TOKEN_LOSS_COOLDOWN_MS - 1000 },
      });
      const result = rm.canOpenPosition("aave", 500);
      expect(result.allowed).toBe(true);
    });

    it("allows entry for a different token unaffected by cooldown", () => {
      rm.updatePortfolio({
        totalValue: 10000,
        cash: 10000,
        positions: [],
        dailyPnl: 0,
        weeklyPnl: 0,
        monthlyPnl: 0,
        tokenConsecLosses: { aave: 3 },
        tokenLossCooldowns: { aave: Date.now() },
      });
      const result = rm.canOpenPosition("bitcoin", 500);
      expect(result.allowed).toBe(true);
    });

    it("constants have expected values", () => {
      expect(TOKEN_CONSEC_LOSS_LIMIT).toBe(2);
      expect(TOKEN_LOSS_COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
    });
  });
});
