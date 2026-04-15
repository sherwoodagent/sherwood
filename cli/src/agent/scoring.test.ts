/**
 * Unit tests for the signal scoring engine — scoreTechnical, scoreSentiment, computeTradeDecision.
 */

import { describe, it, expect } from "vitest";
import {
  scoreTechnical,
  scoreSentiment,
  computeTradeDecision,
  type Signal,
} from "./scoring.js";
import type { TechnicalSignals } from "./technical.js";

// Helper to build a TechnicalSignals object with sensible defaults
function makeTechnicalSignals(overrides: Partial<TechnicalSignals> = {}): TechnicalSignals {
  return {
    rsi: 50,
    macd: { value: 0, signal: 0, histogram: 0 },
    bb: { upper: 110, middle: 100, lower: 90, width: 20, squeeze: false },
    ema: { ema8: 100, ema21: 99, ema50: 98, ema200: 97 },
    atr: 2.5,
    vwap: 100,
    volume: { current: 1000, avg20: 1000, ratio: 1.0 },
    ...overrides,
  };
}

// ── scoreTechnical ──

describe("scoreTechnical", () => {
  it("produces positive score for bullish signals (low RSI + positive MACD)", () => {
    const signals = makeTechnicalSignals({
      rsi: 20, // oversold
      macd: { value: 1, signal: 0.5, histogram: 0.5 }, // positive histogram
    });
    const result = scoreTechnical(signals);
    expect(result.value).toBeGreaterThan(0);
    expect(result.name).toBe("technical");
    expect(result.details).toMatch(/oversold/i);
  });

  it("produces negative score for bearish signals (high RSI + negative MACD)", () => {
    const signals = makeTechnicalSignals({
      rsi: 80, // overbought
      macd: { value: -1, signal: -0.5, histogram: -0.5 }, // negative histogram
      ema: { ema8: 95, ema21: 96, ema50: 97, ema200: 98 }, // bearish alignment
    });
    const result = scoreTechnical(signals);
    expect(result.value).toBeLessThan(0);
    expect(result.details).toMatch(/overbought/i);
  });

  it("produces near-zero score for neutral indicators (RSI ~50, MACD ~0)", () => {
    const signals = makeTechnicalSignals({
      rsi: 50,
      macd: { value: 0, signal: 0, histogram: 0 },
    });
    const result = scoreTechnical(signals);
    expect(Math.abs(result.value)).toBeLessThan(0.5);
  });

  it("clamps value to [-1, 1] range even with extreme inputs", () => {
    const signals = makeTechnicalSignals({
      rsi: 5, // extreme oversold
      macd: { value: 5, signal: 1, histogram: 4 },
      ema: { ema8: 110, ema21: 105, ema50: 100, ema200: 95 }, // bullish alignment
      bb: { upper: 110, middle: 100, lower: 105, width: 5, squeeze: false },
      volume: { current: 5000, avg20: 1000, ratio: 5.0 },
    });
    const result = scoreTechnical(signals);
    expect(result.value).toBeLessThanOrEqual(1);
    expect(result.value).toBeGreaterThanOrEqual(-1);
  });

  it("reduces confidence when most indicators are NaN", () => {
    const signals = makeTechnicalSignals({
      rsi: NaN,
      macd: { value: NaN, signal: NaN, histogram: NaN },
      bb: { upper: NaN, middle: NaN, lower: NaN, width: NaN, squeeze: false },
      ema: { ema8: NaN, ema21: NaN, ema50: NaN, ema200: NaN },
    });
    const result = scoreTechnical(signals);
    expect(result.confidence).toBeLessThan(0.3);
    expect(result.details).toMatch(/Insufficient data/);
  });

  it("adds bullish EMA alignment bonus when 8>21>50>200", () => {
    const signals = makeTechnicalSignals({
      rsi: 50,
      macd: { value: 0, signal: 0, histogram: 0 },
      ema: { ema8: 104, ema21: 103, ema50: 102, ema200: 101 },
    });
    const result = scoreTechnical(signals);
    expect(result.value).toBeGreaterThan(0);
    expect(result.details).toMatch(/Bullish EMA alignment/);
  });
});

// ── scoreSentiment ──

describe("scoreSentiment", () => {
  it("produces max buy signal for extreme fear (F&G < 15)", () => {
    const result = scoreSentiment(10);
    expect(result.value).toBe(1.0);
    expect(result.confidence).toBe(0.8);
    expect(result.details).toMatch(/Extreme fear/);
  });

  it("produces buy signal for moderate fear (F&G 15-25)", () => {
    const result = scoreSentiment(20);
    expect(result.value).toBeGreaterThan(0.5);
    expect(result.value).toBeLessThan(1.0);
    expect(result.details).toMatch(/contrarian buy/i);
  });

  it("produces sell signal for extreme greed (F&G > 75)", () => {
    const result = scoreSentiment(90);
    expect(result.value).toBeLessThan(-0.5);
    expect(result.confidence).toBe(0.8);
    expect(result.details).toMatch(/Extreme greed/);
  });

  it("produces mild sell signal for moderate greed (F&G 60-75)", () => {
    const result = scoreSentiment(70);
    expect(result.value).toBeLessThan(0);
    expect(result.value).toBeGreaterThan(-0.6);
    expect(result.details).toMatch(/Greed/);
  });

  it("produces neutral signal for balanced sentiment (F&G 40-60)", () => {
    const result = scoreSentiment(50);
    expect(result.value).toBe(0);
    expect(result.details).toMatch(/Neutral/);
  });

  it("adjusts for z-score when provided", () => {
    // Neutral sentiment + positive z-score
    const baseline = scoreSentiment(50);
    const adjusted = scoreSentiment(50, 2.0);
    // z-score of 2.0 * 0.1 = +0.2 adjustment
    expect(adjusted.value).toBeGreaterThan(baseline.value);
  });

  it("clamps result to [-1, 1] even with extreme z-score", () => {
    const result = scoreSentiment(5, 100); // extreme fear + huge z-score
    expect(result.value).toBeLessThanOrEqual(1);
    expect(result.value).toBeGreaterThanOrEqual(-1);
  });
});

// ── computeTradeDecision ──

describe("computeTradeDecision", () => {
  function makeSignal(name: string, value: number, confidence = 0.8): Signal {
    return {
      name,
      value,
      confidence,
      source: name,
      details: `${name} signal at ${value}`,
    };
  }

  it("produces STRONG_BUY when composite score exceeds 0.6", () => {
    const signals: Signal[] = [
      makeSignal("technical", 0.9),
      makeSignal("sentiment", 0.8),
      makeSignal("onchain", 0.7),
      makeSignal("fundamental", 0.8),
      makeSignal("event", 0.7),
      makeSignal("smartMoney", 0.9),
    ];
    const decision = computeTradeDecision(signals);
    expect(decision.action).toBe("STRONG_BUY");
    expect(decision.score).toBeGreaterThan(0.6);
  });

  it("produces BUY when composite score is between 0.3 and 0.6", () => {
    const signals: Signal[] = [
      makeSignal("technical", 0.5),
      makeSignal("sentiment", 0.4),
      makeSignal("onchain", 0.3),
      makeSignal("fundamental", 0.4),
      makeSignal("event", 0.3),
      makeSignal("smartMoney", 0.4),
    ];
    const decision = computeTradeDecision(signals);
    expect(decision.action).toBe("BUY");
    expect(decision.score).toBeGreaterThan(0.3);
    expect(decision.score).toBeLessThanOrEqual(0.6);
  });

  it("produces HOLD when composite score is near zero", () => {
    const signals: Signal[] = [
      makeSignal("technical", 0.1),
      makeSignal("sentiment", -0.1),
      makeSignal("onchain", 0.05),
      makeSignal("fundamental", -0.05),
      makeSignal("event", 0),
      makeSignal("smartMoney", 0),
    ];
    const decision = computeTradeDecision(signals);
    expect(decision.action).toBe("HOLD");
    expect(decision.score).toBeGreaterThan(-0.3);
    expect(decision.score).toBeLessThanOrEqual(0.3);
  });

  it("produces SELL when composite score is between -0.6 and -0.3", () => {
    const signals: Signal[] = [
      makeSignal("technical", -0.5),
      makeSignal("sentiment", -0.4),
      makeSignal("onchain", -0.3),
      makeSignal("fundamental", -0.4),
      makeSignal("event", -0.3),
      makeSignal("smartMoney", -0.4),
    ];
    const decision = computeTradeDecision(signals);
    expect(decision.action).toBe("SELL");
    expect(decision.score).toBeLessThan(-0.3);
    expect(decision.score).toBeGreaterThanOrEqual(-0.6);
  });

  it("produces STRONG_SELL when composite score is below -0.6", () => {
    const signals: Signal[] = [
      makeSignal("technical", -0.9),
      makeSignal("sentiment", -0.8),
      makeSignal("onchain", -0.7),
      makeSignal("fundamental", -0.8),
      makeSignal("event", -0.7),
      makeSignal("smartMoney", -0.9),
    ];
    const decision = computeTradeDecision(signals);
    expect(decision.action).toBe("STRONG_SELL");
    expect(decision.score).toBeLessThan(-0.6);
  });

  it("returns a valid timestamp", () => {
    const before = Date.now();
    const decision = computeTradeDecision([makeSignal("technical", 0)]);
    const after = Date.now();
    expect(decision.timestamp).toBeGreaterThanOrEqual(before);
    expect(decision.timestamp).toBeLessThanOrEqual(after);
  });

  it("includes reasoning from all signals", () => {
    const signals: Signal[] = [
      makeSignal("technical", 0.5),
      makeSignal("sentiment", 0.3),
    ];
    const decision = computeTradeDecision(signals);
    expect(decision.reasoning).toContain("technical");
    expect(decision.reasoning).toContain("sentiment");
  });

  it("handles empty signals array with HOLD action", () => {
    const decision = computeTradeDecision([]);
    expect(decision.action).toBe("HOLD");
    expect(decision.score).toBe(0);
  });

  // ── Regime-conditional thresholds ──

  it("trending-up regime fires BUY at lower score than default", () => {
    // Score ~0.27 would HOLD under default (0.3 threshold) but BUY in trending-up (0.25 threshold)
    const signals: Signal[] = [
      makeSignal("technical", 0.3),
      makeSignal("sentiment", 0.3),
      makeSignal("onchain", 0.3),
      makeSignal("fundamental", 0.3),
      makeSignal("event", 0.0),
      makeSignal("smartMoney", 0.3),
    ];
    const defaultDecision = computeTradeDecision(signals);
    const trendingUpDecision = computeTradeDecision(
      signals,
      undefined,
      undefined,
      undefined,
      "trending-up",
    );
    // Scores may differ: trending-up dampens lagging technical signals by 50%,
    // so the aggregate shifts toward the non-technical (bullish) signals.
    // Both should be positive; trending-up fires BUY at its lower 0.25 threshold.
    expect(trendingUpDecision.score).toBeGreaterThan(0.25);
    expect(trendingUpDecision.action).toBe("BUY");
    expect(trendingUpDecision.thresholds?.buy).toBe(0.25);
  });

  it("ranging regime fires BUY at the lowered 0.25 threshold", () => {
    // Use 3 categories so convergence bonus doesn't fire (needs >=4).
    // Score ~0.27 → BUY under ranging (0.25 threshold). Was HOLD under prior 0.30.
    const signals: Signal[] = [
      makeSignal("technical", 0.27),
      makeSignal("sentiment", 0.27),
      makeSignal("onchain", 0.27),
    ];
    const rangingDecision = computeTradeDecision(
      signals,
      undefined,
      undefined,
      undefined,
      "ranging",
    );
    expect(rangingDecision.score).toBeGreaterThan(0.25);
    expect(rangingDecision.score).toBeLessThan(0.3);
    expect(rangingDecision.action).toBe("BUY");
    expect(rangingDecision.thresholds?.buy).toBe(0.25);
    expect(rangingDecision.thresholds?.sell).toBe(-0.25);
  });

  it("trending-up is asymmetric — harder to SELL than default", () => {
    // Use 3 categories to avoid convergence bonus.
    const signals: Signal[] = [
      makeSignal("technical", -0.35),
      makeSignal("sentiment", -0.35),
      makeSignal("onchain", -0.35),
    ];
    const trendingUpDecision = computeTradeDecision(
      signals,
      undefined,
      undefined,
      undefined,
      "trending-up",
    );
    expect(trendingUpDecision.score).toBeLessThan(-0.3);
    expect(trendingUpDecision.score).toBeGreaterThan(-0.4);
    expect(trendingUpDecision.action).toBe("HOLD");
  });

  it("score at buy threshold fires BUY (symmetric boundary)", () => {
    // Use a single signal to avoid FP rounding from weighted-average division.
    // Ranging BUY threshold = 0.30. Signal at exactly 0.30 → score = 0.30.
    const signals: Signal[] = [makeSignal("technical", 0.30)];
    const decision = computeTradeDecision(
      signals, undefined, undefined, undefined, "ranging",
    );
    expect(decision.score).toBe(0.30);
    expect(decision.action).toBe("BUY");
  });

  it("score at sell threshold fires SELL (symmetric boundary)", () => {
    const signals: Signal[] = [makeSignal("technical", -0.30)];
    const decision = computeTradeDecision(
      signals, undefined, undefined, undefined, "ranging",
    );
    expect(decision.score).toBe(-0.30);
    expect(decision.action).toBe("SELL");
  });

  it("score == strongSell threshold fires STRONG_SELL", () => {
    // 3 categories to avoid convergence bonus.
    // Ranging strongSell = -0.55 (from REGIME_THRESHOLDS).
    const signals: Signal[] = [
      makeSignal("technical", -0.55),
      makeSignal("sentiment", -0.55),
      makeSignal("onchain", -0.55),
    ];
    const decision = computeTradeDecision(
      signals, undefined, undefined, undefined, "ranging",
    );
    expect(decision.score).toBeCloseTo(-0.55, 5);
    expect(decision.action).toBe("STRONG_SELL");
  });

  it("convergence bonus amplifies score when 4+ categories agree", () => {
    // 5 categories bullish → 1.30x bonus
    const signals: Signal[] = [
      makeSignal("technical", 0.3),
      makeSignal("sentiment", 0.3),
      makeSignal("onchain", 0.3),
      makeSignal("fundamental", 0.2),
      makeSignal("smartMoney", 0.2),
    ];
    const decision = computeTradeDecision(signals);
    // Base weighted avg ≈ 0.26. With 5/5 convergence → ×1.30 ≈ 0.34
    expect(decision.score).toBeGreaterThan(0.30);
    expect(decision.action).toBe("BUY");
  });

  it("convergence bonus does not fire with <4 agreeing categories", () => {
    // 3 categories — bonus requires >=4
    const signals: Signal[] = [
      makeSignal("technical", 0.3),
      makeSignal("sentiment", 0.3),
      makeSignal("onchain", 0.3),
    ];
    const decision = computeTradeDecision(signals);
    expect(decision.score).toBeCloseTo(0.3, 2); // no bonus
  });

  it("convergence bonus does not fire when categories disagree", () => {
    // 4 categories: 2 bullish, 2 bearish — only 2 agree with positive aggregate
    const signals: Signal[] = [
      makeSignal("technical", 0.5),
      makeSignal("sentiment", 0.4),
      makeSignal("onchain", -0.3),
      makeSignal("fundamental", -0.2),
    ];
    const decision = computeTradeDecision(signals);
    // Only 2/4 agree with the positive aggregate → no bonus.
    // Weighted avg of mixed signals, compressed by disagreement.
    expect(decision.score).toBeLessThan(0.20);
    expect(decision.score).toBeGreaterThan(0.0); // net positive because bull signals are larger
  });

  it("records thresholds used on the decision for replay", () => {
    const signals: Signal[] = [makeSignal("technical", 0.5)];
    const decision = computeTradeDecision(
      signals,
      undefined,
      undefined,
      undefined,
      "high-volatility",
    );
    expect(decision.thresholds).toEqual({
      strongBuy: 0.7,
      buy: 0.45,
      sell: -0.45,
      strongSell: -0.7,
    });
  });

  it("uses _weightOverride when provided on a signal", () => {
    // Give technical a massive override weight so it dominates
    const tech: Signal = {
      name: "technical",
      value: 0.9,
      confidence: 0.9,
      source: "Technical",
      details: "strong buy",
      _weightOverride: 10.0,
    };
    const sentiment: Signal = makeSignal("sentiment", -0.5);
    const decision = computeTradeDecision([tech, sentiment]);
    // Technical should dominate due to weight override
    expect(decision.score).toBeGreaterThan(0.5);
  });
});
