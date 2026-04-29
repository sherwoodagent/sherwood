/**
 * Tests for the LLM judge module — confirm/veto layer.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockChatCompletion, mockGetKey } = vi.hoisted(() => ({
  mockChatCompletion: vi.fn(),
  mockGetKey: vi.fn<() => string | undefined>().mockReturnValue("test-key"),
}));

vi.mock("../lib/venice.js", () => ({
  chatCompletion: mockChatCompletion,
}));

vi.mock("../lib/config.js", () => ({
  getVeniceApiKey: mockGetKey,
  loadConfig: vi.fn(() => ({ groupCache: {} })),
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
    mockChatCompletion.mockResolvedValueOnce({
      content: JSON.stringify({ verdict: "confirm", reasoning: "Signals align", risks: [], confidence: 0.8 }),
      model: "llama-3.3-70b", usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(result.verdict.reasoning).toBe("Signals align");
    expect(result.verdict.confidence).toBe(0.8);
    expect(mockChatCompletion).toHaveBeenCalledOnce();
  });

  it("vetoes when model returns veto verdict", async () => {
    mockChatCompletion.mockResolvedValueOnce({
      content: JSON.stringify({ verdict: "veto", reasoning: "Regime contradiction", risks: ["trending-down for long"], confidence: 0.9 }),
      model: "llama-3.3-70b", usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("veto");
    expect(result.verdict.reasoning).toBe("Regime contradiction");
    expect(result.verdict.risks).toEqual(["trending-down for long"]);
  });

  it("falls back to confirm on bad JSON", async () => {
    mockChatCompletion.mockResolvedValueOnce({
      content: "This is not JSON at all!",
      model: "llama-3.3-70b", usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(result.verdict.reasoning).toBe("fallback");
  });

  it("falls back to confirm on timeout", async () => {
    mockChatCompletion.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(result.verdict.reasoning).toBe("fallback");
  });

  it("falls back to confirm on SDK error", async () => {
    mockChatCompletion.mockRejectedValueOnce(new Error("500 Internal Server Error"));

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(result.verdict.reasoning).toBe("fallback");
  });

  it("skips judge when score is outside band (above)", async () => {
    const ctx = makeContext({ decision: makeDecision({ score: 0.55 }) });
    const result = await judge(ctx, enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(result.verdict.reasoning).toBe("fallback");
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it("skips judge when action is HOLD", async () => {
    const ctx = makeContext({ decision: makeDecision({ action: "HOLD", score: 0.15 }) });
    const result = await judge(ctx, enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it("skips judge when no API key", async () => {
    mockGetKey.mockReturnValueOnce(undefined);

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(mockChatCompletion).not.toHaveBeenCalled();
  });

  it("strips markdown fences from model response", async () => {
    mockChatCompletion.mockResolvedValueOnce({
      content: '```json\n{"verdict":"confirm","reasoning":"OK","risks":[],"confidence":0.7}\n```',
      model: "llama-3.3-70b", usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    });

    const result = await judge(makeContext(), enabledConfig);
    expect(result.verdict.verdict).toBe("confirm");
    expect(result.verdict.confidence).toBe(0.7);
  });

  it("clamps confidence to [0, 1]", async () => {
    mockChatCompletion.mockResolvedValueOnce({
      content: JSON.stringify({ verdict: "confirm", reasoning: "test", risks: [], confidence: 5.0 }),
      model: "llama-3.3-70b", usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
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
      { token: "bitcoin", score: 0.55, action: "STRONG_BUY" },
      { token: "ethereum", score: 0.05, action: "BUY" },
      { token: "aave", score: 0.25, action: "BUY" },
    ];

    const config: JudgeConfig = { ...DEFAULT_JUDGE_CONFIG, enabled: true, topN: 3 };
    const candidates = selectJudgeCandidates(results, config);

    expect(candidates.size).toBe(1);
    expect(candidates.has("aave")).toBe(true);
  });

  it("treats scoreBand upper as exclusive (matches judge() gate)", () => {
    // At abs(score) === scoreBand[1] (default 0.50), selectJudgeCandidates
    // must NOT pick the token — judge() rejects it at the identical bound
    // with `absScore > scoreBand[1]` === false, leading to fallback confirm.
    // Prior bug: `abs <= scoreBand[1]` selected it; judge() fallback-confirmed.
    const results = [
      { token: "bitcoin", score: 0.50, action: "BUY" },
      { token: "ethereum", score: 0.499, action: "BUY" },
      { token: "solana", score: -0.50, action: "SELL" },
    ];

    const config: JudgeConfig = { ...DEFAULT_JUDGE_CONFIG, enabled: true, topN: 3, scoreBand: [0.10, 0.50] };
    const candidates = selectJudgeCandidates(results, config);

    expect(candidates.size).toBe(1);
    expect(candidates.has("bitcoin")).toBe(false);
    expect(candidates.has("solana")).toBe(false);
    expect(candidates.has("ethereum")).toBe(true);
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
