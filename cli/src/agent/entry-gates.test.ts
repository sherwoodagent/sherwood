/**
 * Tests for the velocity freshness gate (Orca-inspired).
 * Covers: direction-aware downgrades, thresholds, missing data, opt-out,
 * and the strict-equality edge case at zero velocity.
 */
import { describe, it, expect, vi } from "vitest";
import {
  applyVelocityGate,
  applyRegimeGate,
  applyRealAlphaGate,
  deriveVelocityFromCandles,
  resolveVelocity,
  DEFAULT_ENTRY_GATE_CONFIG,
  VELOCITY_GATE_BUY_MIN_PCT,
  VELOCITY_GATE_SELL_MAX_PCT,
  SHORT_ALLOWED_REGIMES,
} from "./entry-gates.js";
import type { MarketRegime } from "./regime.js";
import type { TokenAnalysis } from "./index.js";
import type { Candle } from "./technical.js";
import type { Signal } from "./scoring.js";

function makeAnalysis(
  token: string,
  action: TokenAnalysis["decision"]["action"],
  score: number,
  signals: Signal[] = [],
): TokenAnalysis {
  return {
    token,
    decision: {
      action,
      score,
      signals,
      reasoning: "test",
      confidence: 0.6,
      timestamp: Date.now(),
    },
    data: { price: 100 },
  };
}

describe("applyVelocityGate", () => {
  it("passes BUY through when 1h velocity is positive", () => {
    const input = makeAnalysis("ethereum", "BUY", 0.35);
    const result = applyVelocityGate(input, 0.015); // +1.5%
    expect(result.decision.action).toBe("BUY");
    expect(result.preVelocity).toBeUndefined();
  });

  it("passes STRONG_BUY through with a strong positive velocity", () => {
    const input = makeAnalysis("bitcoin", "STRONG_BUY", 0.7);
    const result = applyVelocityGate(input, 0.05);
    expect(result.decision.action).toBe("STRONG_BUY");
    expect(result.preVelocity).toBeUndefined();
  });

  it("downgrades BUY when velocity is mildly negative (just past threshold)", () => {
    const input = makeAnalysis("solana", "BUY", 0.33);
    // -1.5% < -1.0% threshold
    const result = applyVelocityGate(input, -0.015);
    expect(result.decision.action).toBe("HOLD");
    expect(result.preVelocity).toEqual({ action: "BUY", score: 0.33 });
    // Original score preserved on the (post-gate) decision too — only action mutated.
    expect(result.decision.score).toBe(0.33);
  });

  it("downgrades BUY when velocity is strongly negative", () => {
    const input = makeAnalysis("arbitrum", "BUY", 0.4);
    const result = applyVelocityGate(input, -0.025); // -2.5%
    expect(result.decision.action).toBe("HOLD");
    expect(result.preVelocity).toEqual({ action: "BUY", score: 0.4 });
  });

  it("downgrades STRONG_BUY the same way as BUY", () => {
    const input = makeAnalysis("hyperliquid", "STRONG_BUY", 0.75);
    const result = applyVelocityGate(input, -0.01);
    expect(result.decision.action).toBe("HOLD");
    expect(result.preVelocity).toEqual({ action: "STRONG_BUY", score: 0.75 });
  });

  it("downgrades BUY at exactly the threshold (strict <=)", () => {
    // Velocity exactly equal to the threshold should reject — confirms the
    // comparison operator is `<=`, not `<`. Use threshold=0 so "exactly 0
    // velocity" becomes the edge the spec calls out.
    const input = makeAnalysis("aave", "BUY", 0.3);
    const result = applyVelocityGate(input, 0, {
      ...DEFAULT_ENTRY_GATE_CONFIG,
      velocityGateBuyMinPct: 0,
    });
    expect(result.decision.action).toBe("HOLD");
    expect(result.preVelocity?.action).toBe("BUY");
  });

  it("downgrades BUY exactly at default threshold (-1.0%)", () => {
    const input = makeAnalysis("aave", "BUY", 0.3);
    const result = applyVelocityGate(input, -0.01);
    expect(result.decision.action).toBe("HOLD");
  });

  it("allows BUY at a just-barely-positive velocity above the threshold", () => {
    const input = makeAnalysis("uniswap", "BUY", 0.31);
    // -0.2% is > -0.3% threshold → passes
    const result = applyVelocityGate(input, -0.002);
    expect(result.decision.action).toBe("BUY");
    expect(result.preVelocity).toBeUndefined();
  });

  it("downgrades SELL when velocity is positive (rising price)", () => {
    const input = makeAnalysis("dogecoin", "SELL", -0.35);
    const result = applyVelocityGate(input, 0.01); // +1%
    expect(result.decision.action).toBe("HOLD");
    expect(result.preVelocity).toEqual({ action: "SELL", score: -0.35 });
  });

  it("downgrades STRONG_SELL when velocity is positive", () => {
    const input = makeAnalysis("pepe", "STRONG_SELL", -0.75);
    const result = applyVelocityGate(input, 0.015);
    expect(result.decision.action).toBe("HOLD");
    expect(result.preVelocity).toEqual({ action: "STRONG_SELL", score: -0.75 });
  });

  it("passes SELL through when velocity is clearly negative", () => {
    const input = makeAnalysis("ripple", "SELL", -0.4);
    const result = applyVelocityGate(input, -0.02);
    expect(result.decision.action).toBe("SELL");
    expect(result.preVelocity).toBeUndefined();
  });

  it("downgrades SELL at exactly the threshold (strict >=)", () => {
    const input = makeAnalysis("polkadot", "SELL", -0.3);
    // Threshold=0 → velocity=0 must reject (confirms `>=` not `>`).
    const result = applyVelocityGate(input, 0, {
      ...DEFAULT_ENTRY_GATE_CONFIG,
      velocityGateSellMaxPct: 0,
    });
    expect(result.decision.action).toBe("HOLD");
  });

  it("downgrades SELL exactly at default threshold (+1.0%)", () => {
    const input = makeAnalysis("polkadot", "SELL", -0.3);
    const result = applyVelocityGate(input, 0.01);
    expect(result.decision.action).toBe("HOLD");
  });

  it("never gates HOLD decisions", () => {
    const input = makeAnalysis("bitcoin", "HOLD", 0.1);
    // Even with a clearly-negative velocity, HOLD should pass through untouched.
    const result = applyVelocityGate(input, -0.05);
    expect(result.decision.action).toBe("HOLD");
    expect(result.preVelocity).toBeUndefined();
  });

  it("skips the gate when velocity is undefined (no data)", () => {
    const input = makeAnalysis("ethereum", "BUY", 0.35);
    const result = applyVelocityGate(input, undefined);
    expect(result.decision.action).toBe("BUY");
    expect(result.preVelocity).toBeUndefined();
  });

  it("skips the gate when velocity is NaN", () => {
    const input = makeAnalysis("ethereum", "SELL", -0.35);
    const result = applyVelocityGate(input, NaN);
    expect(result.decision.action).toBe("SELL");
    expect(result.preVelocity).toBeUndefined();
  });

  it("skips the gate entirely when disabled via config", () => {
    const input = makeAnalysis("solana", "BUY", 0.35);
    const result = applyVelocityGate(input, -0.05, {
      ...DEFAULT_ENTRY_GATE_CONFIG,
      velocityGateEnabled: false,
    });
    expect(result.decision.action).toBe("BUY");
    expect(result.preVelocity).toBeUndefined();
  });

  it("respects custom thresholds", () => {
    const input = makeAnalysis("bitcoin", "BUY", 0.4);
    // With a laxer threshold (-1%), a -0.5% velocity should pass.
    const laxResult = applyVelocityGate(input, -0.005, {
      ...DEFAULT_ENTRY_GATE_CONFIG,
      velocityGateBuyMinPct: -0.01,
    });
    expect(laxResult.decision.action).toBe("BUY");

    // With a stricter threshold (+0.1%), a +0.05% velocity should fail.
    const strictResult = applyVelocityGate(input, 0.0005, {
      ...DEFAULT_ENTRY_GATE_CONFIG,
      velocityGateBuyMinPct: 0.001,
    });
    expect(strictResult.decision.action).toBe("HOLD");
  });

  it("invokes the logger with a descriptive message on downgrade", () => {
    const input = makeAnalysis("ethereum", "BUY", 0.35);
    const logger = vi.fn();
    applyVelocityGate(input, -0.01, DEFAULT_ENTRY_GATE_CONFIG, logger);
    expect(logger).toHaveBeenCalledOnce();
    const msg = logger.mock.calls[0]![0]!;
    expect(msg).toContain("DOWNGRADE");
    expect(msg).toContain("ethereum");
    expect(msg).toContain("BUY");
    expect(msg).toMatch(/-1\.00%/); // velocity shown as percent
  });

  it("does not mutate the original result object", () => {
    const input = makeAnalysis("ethereum", "BUY", 0.35);
    const originalAction = input.decision.action;
    applyVelocityGate(input, -0.01);
    expect(input.decision.action).toBe(originalAction);
    expect(input.preVelocity).toBeUndefined();
  });
});

describe("deriveVelocityFromCandles", () => {
  function candle(ts: number, close: number): Candle {
    return { timestamp: ts, open: close, high: close, low: close, close, volume: 0 };
  }

  it("returns the fractional change between the last two candles", () => {
    const v = deriveVelocityFromCandles([candle(1, 100), candle(2, 102)]);
    expect(v).toBeCloseTo(0.02, 6);
  });

  it("returns a negative value when the most recent candle is lower", () => {
    const v = deriveVelocityFromCandles([candle(1, 100), candle(2, 97)]);
    expect(v).toBeCloseTo(-0.03, 6);
  });

  it("returns undefined when there aren't enough candles", () => {
    expect(deriveVelocityFromCandles(undefined)).toBeUndefined();
    expect(deriveVelocityFromCandles([])).toBeUndefined();
    expect(deriveVelocityFromCandles([candle(1, 100)])).toBeUndefined();
  });

  it("returns undefined on a zero previous close (guard against /0)", () => {
    expect(deriveVelocityFromCandles([candle(1, 0), candle(2, 100)])).toBeUndefined();
  });
});

describe("resolveVelocity", () => {
  it("prefers the explicit 1h price change when provided", () => {
    const candles: Candle[] = [
      { timestamp: 1, open: 100, high: 100, low: 100, close: 100, volume: 0 },
      { timestamp: 2, open: 100, high: 100, low: 100, close: 99, volume: 0 },
    ];
    // Candles say -1% but explicit 1h says +2% → explicit wins.
    const v = resolveVelocity(0.02, candles);
    expect(v).toBeCloseTo(0.02, 6);
  });

  it("falls back to candles when no explicit change is provided", () => {
    const candles: Candle[] = [
      { timestamp: 1, open: 100, high: 100, low: 100, close: 100, volume: 0 },
      { timestamp: 2, open: 100, high: 100, low: 100, close: 101, volume: 0 },
    ];
    const v = resolveVelocity(undefined, candles);
    expect(v).toBeCloseTo(0.01, 6);
  });

  it("falls back to candles when priceChg1h is NaN", () => {
    const candles: Candle[] = [
      { timestamp: 1, open: 100, high: 100, low: 100, close: 100, volume: 0 },
      { timestamp: 2, open: 100, high: 100, low: 100, close: 103, volume: 0 },
    ];
    const v = resolveVelocity(NaN, candles);
    expect(v).toBeCloseTo(0.03, 6);
  });

  it("returns undefined when neither source is available", () => {
    expect(resolveVelocity(undefined, undefined)).toBeUndefined();
    expect(resolveVelocity(undefined, [])).toBeUndefined();
  });
});

describe("exported defaults", () => {
  it("are symmetric (BUY and SELL thresholds mirror each other)", () => {
    expect(VELOCITY_GATE_BUY_MIN_PCT).toBe(-0.01);
    expect(VELOCITY_GATE_SELL_MAX_PCT).toBe(0.01);
    expect(VELOCITY_GATE_BUY_MIN_PCT).toBe(-VELOCITY_GATE_SELL_MAX_PCT);
  });

  it("DEFAULT_ENTRY_GATE_CONFIG has gate enabled", () => {
    expect(DEFAULT_ENTRY_GATE_CONFIG.velocityGateEnabled).toBe(true);
    expect(DEFAULT_ENTRY_GATE_CONFIG.velocityGateBuyMinPct).toBe(VELOCITY_GATE_BUY_MIN_PCT);
    expect(DEFAULT_ENTRY_GATE_CONFIG.velocityGateSellMaxPct).toBe(VELOCITY_GATE_SELL_MAX_PCT);
  });

  it("DEFAULT_ENTRY_GATE_CONFIG has regime gate enabled", () => {
    expect(DEFAULT_ENTRY_GATE_CONFIG.regimeGateEnabled).toBe(true);
  });

  it("DEFAULT_ENTRY_GATE_CONFIG has real-alpha gate enabled", () => {
    expect(DEFAULT_ENTRY_GATE_CONFIG.realAlphaGateEnabled).toBe(true);
  });
});

describe("applyRegimeGate", () => {
  it("blocks SELL in trending-up regime", () => {
    const input = makeAnalysis("aave", "SELL", -0.35);
    const result = applyRegimeGate(input, "trending-up");
    expect(result.decision.action).toBe("HOLD");
    expect(result.preRegime).toEqual({ action: "SELL", score: -0.35 });
  });

  it("blocks STRONG_SELL in trending-up regime", () => {
    const input = makeAnalysis("fartcoin", "STRONG_SELL", -0.75);
    const result = applyRegimeGate(input, "trending-up");
    expect(result.decision.action).toBe("HOLD");
    expect(result.preRegime).toEqual({ action: "STRONG_SELL", score: -0.75 });
  });

  it("blocks SELL in ranging regime", () => {
    const input = makeAnalysis("ethena", "SELL", -0.30);
    const result = applyRegimeGate(input, "ranging");
    expect(result.decision.action).toBe("HOLD");
    expect(result.preRegime).toEqual({ action: "SELL", score: -0.30 });
  });

  it("blocks SELL in low-volatility regime", () => {
    const input = makeAnalysis("bitcoin", "SELL", -0.35);
    const result = applyRegimeGate(input, "low-volatility");
    expect(result.decision.action).toBe("HOLD");
    expect(result.preRegime).toEqual({ action: "SELL", score: -0.35 });
  });

  it("allows SELL in trending-down regime", () => {
    const input = makeAnalysis("ethereum", "SELL", -0.40);
    const result = applyRegimeGate(input, "trending-down");
    expect(result.decision.action).toBe("SELL");
    expect(result.preRegime).toBeUndefined();
  });

  it("allows STRONG_SELL in trending-down regime", () => {
    const input = makeAnalysis("solana", "STRONG_SELL", -0.70);
    const result = applyRegimeGate(input, "trending-down");
    expect(result.decision.action).toBe("STRONG_SELL");
    expect(result.preRegime).toBeUndefined();
  });

  it("allows SELL in high-volatility regime", () => {
    const input = makeAnalysis("aave", "SELL", -0.50);
    const result = applyRegimeGate(input, "high-volatility");
    expect(result.decision.action).toBe("SELL");
    expect(result.preRegime).toBeUndefined();
  });

  it("never gates BUY signals regardless of regime", () => {
    const regimes: MarketRegime[] = ["trending-up", "trending-down", "ranging", "high-volatility", "low-volatility"];
    for (const regime of regimes) {
      const input = makeAnalysis("bitcoin", "BUY", 0.35);
      const result = applyRegimeGate(input, regime);
      expect(result.decision.action).toBe("BUY");
      expect(result.preRegime).toBeUndefined();
    }
  });

  it("never gates HOLD signals", () => {
    const input = makeAnalysis("bitcoin", "HOLD", 0.0);
    const result = applyRegimeGate(input, "trending-up");
    expect(result.decision.action).toBe("HOLD");
    expect(result.preRegime).toBeUndefined();
  });

  it("skips gate when regime is undefined (no BTC data)", () => {
    const input = makeAnalysis("ethereum", "SELL", -0.40);
    const result = applyRegimeGate(input, undefined);
    expect(result.decision.action).toBe("SELL");
    expect(result.preRegime).toBeUndefined();
  });

  it("skips gate when regimeGateEnabled is false", () => {
    const input = makeAnalysis("aave", "SELL", -0.35);
    const result = applyRegimeGate(input, "trending-up", {
      ...DEFAULT_ENTRY_GATE_CONFIG,
      regimeGateEnabled: false,
    });
    expect(result.decision.action).toBe("SELL");
    expect(result.preRegime).toBeUndefined();
  });

  it("invokes the logger on downgrade", () => {
    const input = makeAnalysis("zcash", "SELL", -0.30);
    const logger = vi.fn();
    applyRegimeGate(input, "ranging", DEFAULT_ENTRY_GATE_CONFIG, logger);
    expect(logger).toHaveBeenCalledOnce();
    const msg = logger.mock.calls[0]![0]!;
    expect(msg).toContain("DOWNGRADE");
    expect(msg).toContain("zcash");
    expect(msg).toContain("SELL");
    expect(msg).toContain("ranging");
  });

  it("does not mutate the original result object", () => {
    const input = makeAnalysis("aave", "SELL", -0.35);
    applyRegimeGate(input, "trending-up");
    expect(input.decision.action).toBe("SELL");
    expect(input.preRegime).toBeUndefined();
  });

  it("SHORT_ALLOWED_REGIMES contains exactly trending-down and high-volatility", () => {
    expect(SHORT_ALLOWED_REGIMES.has("trending-down")).toBe(true);
    expect(SHORT_ALLOWED_REGIMES.has("high-volatility")).toBe(true);
    expect(SHORT_ALLOWED_REGIMES.size).toBe(2);
  });
});

describe("applyRealAlphaGate", () => {
  function signal(name: string, value: number): Signal {
    return {
      name,
      value,
      confidence: 0.8,
      source: name,
      details: `${name}=${value}`,
    };
  }

  it("blocks BUY when only noisy signals support the entry", () => {
    const input = makeAnalysis("bitcoin", "BUY", 0.18, [
      signal("momentum", 0.9),
      signal("tradingviewSignal", 0.7),
      signal("fundingRate", 0.5),
    ]);
    const result = applyRealAlphaGate(input);
    expect(result.decision.action).toBe("HOLD");
    expect(result.preAlpha).toEqual({ action: "BUY", score: 0.18 });
  });

  it("allows BUY when smartMoney is aligned", () => {
    const input = makeAnalysis("ethereum", "BUY", 0.20, [
      signal("smartMoney", 0.16),
      signal("momentum", 0.9),
    ]);
    const result = applyRealAlphaGate(input);
    expect(result.decision.action).toBe("BUY");
    expect(result.preAlpha).toBeUndefined();
  });

  it("allows SELL when a real-alpha signal is bearish", () => {
    const input = makeAnalysis("zcash", "SELL", -0.25, [
      signal("dexFlow", -0.3),
      signal("fundingRate", -0.5),
    ]);
    const result = applyRealAlphaGate(input);
    expect(result.decision.action).toBe("SELL");
    expect(result.preAlpha).toBeUndefined();
  });

  it("skips gate when disabled", () => {
    const input = makeAnalysis("solana", "BUY", 0.18, [
      signal("momentum", 1),
    ]);
    const result = applyRealAlphaGate(input, {
      ...DEFAULT_ENTRY_GATE_CONFIG,
      realAlphaGateEnabled: false,
    });
    expect(result.decision.action).toBe("BUY");
    expect(result.preAlpha).toBeUndefined();
  });
});
