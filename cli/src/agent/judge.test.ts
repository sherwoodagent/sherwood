/**
 * Tests for the LLM judge module — confirm/veto layer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockJudgeCompletion, mockGetKey } = vi.hoisted(() => ({
  mockJudgeCompletion: vi.fn(),
  mockGetKey: vi.fn<() => string | undefined>().mockReturnValue("test-key"),
}));

vi.mock("../lib/anthropic.js", () => ({
  judgeCompletion: mockJudgeCompletion,
}));

vi.mock("../lib/config.js", () => ({
  getAnthropicApiKey: mockGetKey,
  loadConfig: vi.fn(() => ({ groupCache: {} })),
  getVeniceApiKey: vi.fn(),
}));

import { judge, selectJudgeCandidates, DEFAULT_JUDGE_CONFIG } from "./judge.js";
import type { JudgeConfig, JudgeContext } from "./judge.js";
import type { TradeDecision } from "./scoring.js";

function makeDecision(overrides?: Partial<TradeDecision>): TradeDecision {
  return {
    action: "BUY",
    score: 0.25,
    signals: [
      { name: "momentum", value: 0.3, confidence: 0.7, source: "Technical", details: "test" },
      { name: "sentiment", value: 0.2, confidence: 0.6, source: "Sentiment", details: "test" },
    ],
    reasoning: "test",
    confidence: 0.6,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeContext(overrides?: Partial<JudgeContext>): JudgeContext {
  return {
    tokenId: "ethereum",
    currentPrice: 2500,
    decision: makeDecision(),
    fearAndGreed: 45,
    regime: "ranging",
    btcBias: "neutral",
    suppressionFactor: 1.0,
    portfolio: { openCount: 2, cashPct: 0.6, hasPositionThisToken: false, inStopCooldown: false, dailyPnlPct: -0.005 },
    ...overrides,
  };
}

const enabledConfig: JudgeConfig = { ...DEFAULT_JUDGE_CONFIG, enabled: true, cacheTtlMs: 0 };

describe("judge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetKey.mockReturnValue("test-key");
  });

  it("confirms when model returns confirm verdict", async () => {
    mockJudgeCompletion.mockResolvedValueOnce({
      content: JSON.stringify({ verdict: "confirm", reasoning: "Signals align", risks: [], confidence: 0.8 }),
      usage: { input: 100, output: 50 },
    });

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(result.verdict.reasoning).toBe("Signals align");
    expect(result.verdict.confidence).toBe(0.8);
    expect(mockJudgeCompletion).toHaveBeenCalledOnce();
  });

  it("vetoes when model returns veto verdict", async () => {
    mockJudgeCompletion.mockResolvedValueOnce({
      content: JSON.stringify({ verdict: "veto", reasoning: "Regime contradiction", risks: ["trending-down for long"], confidence: 0.9 }),
      usage: { input: 100, output: 50 },
    });

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("veto");
    expect(result.verdict.reasoning).toBe("Regime contradiction");
    expect(result.verdict.risks).toEqual(["trending-down for long"]);
  });

  it("falls back to confirm on bad JSON", async () => {
    mockJudgeCompletion.mockResolvedValueOnce({
      content: "This is not JSON at all!",
      usage: { input: 100, output: 50 },
    });

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(result.verdict.reasoning).toBe("fallback");
  });

  it("falls back to confirm on timeout", async () => {
    mockJudgeCompletion.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(result.verdict.reasoning).toBe("fallback");
  });

  it("falls back to confirm on SDK error", async () => {
    mockJudgeCompletion.mockRejectedValueOnce(new Error("500 Internal Server Error"));

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(result.verdict.reasoning).toBe("fallback");
  });

  it("skips judge when score is outside band (above)", async () => {
    const ctx = makeContext({ decision: makeDecision({ score: 0.45 }) });
    const result = await judge(ctx, enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(result.verdict.reasoning).toBe("fallback");
    expect(mockJudgeCompletion).not.toHaveBeenCalled();
  });

  it("skips judge when action is HOLD", async () => {
    const ctx = makeContext({ decision: makeDecision({ action: "HOLD", score: 0.15 }) });
    const result = await judge(ctx, enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(mockJudgeCompletion).not.toHaveBeenCalled();
  });

  it("skips judge when no API key", async () => {
    mockGetKey.mockReturnValueOnce(undefined);

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(mockJudgeCompletion).not.toHaveBeenCalled();
  });

  it("strips markdown fences from model response", async () => {
    mockJudgeCompletion.mockResolvedValueOnce({
      content: '```json\n{"verdict":"confirm","reasoning":"OK","risks":[],"confidence":0.7}\n```',
      usage: { input: 100, output: 50 },
    });

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(result.verdict.confidence).toBe(0.7);
  });

  it("clamps confidence to [0, 1]", async () => {
    mockJudgeCompletion.mockResolvedValueOnce({
      content: JSON.stringify({ verdict: "confirm", reasoning: "test", risks: [], confidence: 5.0 }),
      usage: { input: 100, output: 50 },
    });

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.confidence).toBe(1.0);
  });
});

describe("selectJudgeCandidates", () => {
  it("selects top-N borderline non-HOLD tokens by |score|", () => {
    const results = [
      { token: "bitcoin", score: 0.32, action: "BUY" },
      { token: "ethereum", score: 0.28, action: "BUY" },
      { token: "solana", score: 0.15, action: "HOLD" },
      { token: "aave", score: 0.20, action: "BUY" },
      { token: "chainlink", score: -0.18, action: "SELL" },
    ];

    const config: JudgeConfig = { ...DEFAULT_JUDGE_CONFIG, enabled: true, topN: 3 };
    const candidates = selectJudgeCandidates(results, config);

    expect(candidates.size).toBe(3);
    expect(candidates.has("bitcoin")).toBe(true);
    expect(candidates.has("ethereum")).toBe(true);
    expect(candidates.has("aave")).toBe(true);
    expect(candidates.has("solana")).toBe(false);
    expect(candidates.has("chainlink")).toBe(false);
  });

  it("excludes tokens outside the score band", () => {
    const results = [
      { token: "bitcoin", score: 0.45, action: "STRONG_BUY" },
      { token: "ethereum", score: 0.05, action: "BUY" },
      { token: "aave", score: 0.25, action: "BUY" },
    ];

    const config: JudgeConfig = { ...DEFAULT_JUDGE_CONFIG, enabled: true, topN: 3 };
    const candidates = selectJudgeCandidates(results, config);

    expect(candidates.size).toBe(1);
    expect(candidates.has("aave")).toBe(true);
  });

  it("respects topN budget cap", () => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      token: `token-${i}`,
      score: 0.20 + i * 0.01,
      action: "BUY" as const,
    }));

    const config: JudgeConfig = { ...DEFAULT_JUDGE_CONFIG, enabled: true, topN: 3 };
    const candidates = selectJudgeCandidates(results, config);

    expect(candidates.size).toBe(3);
  });
});
