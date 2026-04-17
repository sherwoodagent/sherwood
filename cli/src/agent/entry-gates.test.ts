/**
 * Tests for the velocity freshness gate (Orca-inspired).
 * Covers: direction-aware downgrades, thresholds, missing data, opt-out,
 * and the strict-equality edge case at zero velocity.
 */
import { describe, it, expect, vi } from "vitest";
import {
  applyVelocityGate,
  deriveVelocityFromCandles,
  resolveVelocity,
  DEFAULT_ENTRY_GATE_CONFIG,
  VELOCITY_GATE_BUY_MIN_PCT,
  VELOCITY_GATE_SELL_MAX_PCT,
} from "./entry-gates.js";
import type { TokenAnalysis } from "./index.js";
import type { Candle } from "./technical.js";

function makeAnalysis(
  token: string,
  action: TokenAnalysis["decision"]["action"],
  score: number,
): TokenAnalysis {
  return {
    token,
    decision: {
      action,
      score,
      signals: [],
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
    // -0.4% < -0.3% threshold
    const result = applyVelocityGate(input, -0.004);
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

  it("downgrades BUY exactly at default threshold (-0.3%)", () => {
    const input = makeAnalysis("aave", "BUY", 0.3);
    const result = applyVelocityGate(input, -0.003);
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
    const result = applyVelocityGate(input, 0.004);
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

  it("downgrades SELL exactly at default threshold (+0.3%)", () => {
    const input = makeAnalysis("polkadot", "SELL", -0.3);
    const result = applyVelocityGate(input, 0.003);
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
    expect(VELOCITY_GATE_BUY_MIN_PCT).toBe(-0.003);
    expect(VELOCITY_GATE_SELL_MAX_PCT).toBe(0.003);
    expect(VELOCITY_GATE_BUY_MIN_PCT).toBe(-VELOCITY_GATE_SELL_MAX_PCT);
  });

  it("DEFAULT_ENTRY_GATE_CONFIG has gate enabled", () => {
    expect(DEFAULT_ENTRY_GATE_CONFIG.velocityGateEnabled).toBe(true);
    expect(DEFAULT_ENTRY_GATE_CONFIG.velocityGateBuyMinPct).toBe(VELOCITY_GATE_BUY_MIN_PCT);
    expect(DEFAULT_ENTRY_GATE_CONFIG.velocityGateSellMaxPct).toBe(VELOCITY_GATE_SELL_MAX_PCT);
  });
});
