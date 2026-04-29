/**
 * Focused tests for TradingAgent.analyzeAll — verifies the judge-then-log
 * ordering contract (Bug 1 regression test).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture call order across mocked modules.
const callOrder: string[] = [];

const { mockJudge, mockSelect, mockLogSignal } = vi.hoisted(() => ({
  mockJudge: vi.fn(),
  mockSelect: vi.fn(),
  mockLogSignal: vi.fn(),
}));

vi.mock("./judge.js", async () => {
  const actual = await vi.importActual<typeof import("./judge.js")>("./judge.js");
  return {
    ...actual,
    judge: mockJudge,
    selectJudgeCandidates: mockSelect,
  };
});

vi.mock("./signal-logger.js", () => ({
  logSignal: mockLogSignal,
}));

import { TradingAgent } from "./index.js";
import type { TokenAnalysis } from "./index.js";
import type { JudgeVerdict } from "./judge.js";

function makeAnalysis(token: string, score: number): TokenAnalysis {
  return {
    token,
    decision: {
      action: score > 0 ? "BUY" : "SELL",
      score,
      signals: [],
      reasoning: "test",
      confidence: 0.6,
      timestamp: Date.now(),
    },
    data: { price: 100 },
  };
}

describe("TradingAgent.analyzeAll — judge/log ordering (Bug 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callOrder.length = 0;
    mockJudge.mockImplementation(async () => {
      callOrder.push("judge");
      const verdict: JudgeVerdict = {
        verdict: "veto",
        reasoning: "regime mismatch",
        risks: ["test"],
        confidence: 0.9,
      };
      return { verdict, cached: false, latencyMs: 42 };
    });
    mockLogSignal.mockImplementation(() => {
      callOrder.push("log");
    });
  });

  it("calls logSignal AFTER the judge pass and includes judgeData", async () => {
    mockSelect.mockReturnValue(new Set(["ethereum"]));

    const agent = new TradingAgent({
      tokens: ["ethereum"],
      cycle: "15m",
      dryRun: true,
      maxPositionPct: 0.2,
      maxRiskPct: 0.02,
      judge: { enabled: true },
    });

    // Stub analyzeToken — we're not exercising the data pipeline here,
    // just the judge→log ordering in analyzeAll.
    vi.spyOn(agent, "analyzeToken").mockResolvedValue(makeAnalysis("ethereum", 0.3));

    const results = await agent.analyzeAll();

    // 1. Judge ran before log
    expect(callOrder).toEqual(["judge", "log"]);

    // 2. logSignal received judgeData with correct verdict + latency + veto fields
    expect(mockLogSignal).toHaveBeenCalledOnce();
    const [analysis, price, weights, judgeData] = mockLogSignal.mock.calls[0]!;
    expect(analysis.token).toBe("ethereum");
    expect(price).toBe(100);
    expect(weights).toBeDefined();
    expect(judgeData).toBeDefined();
    expect(judgeData.verdict.verdict).toBe("veto");
    expect(judgeData.verdict.reasoning).toBe("regime mismatch");
    expect(judgeData.latencyMs).toBe(42);
    expect(judgeData.cached).toBe(false);
    // preJudge captured the original BUY action/score before veto flipped to HOLD
    expect(judgeData.preJudgeAction).toBe("BUY");
    expect(judgeData.preJudgeScore).toBe(0.3);

    // 3. Post-veto decision was mutated to HOLD on the result
    expect(results[0]!.decision.action).toBe("HOLD");
  });

  it("still logs (without judgeData) when judge is disabled", async () => {
    mockSelect.mockReturnValue(new Set());

    const agent = new TradingAgent({
      tokens: ["bitcoin"],
      cycle: "15m",
      dryRun: true,
      maxPositionPct: 0.2,
      maxRiskPct: 0.02,
      // judge disabled by default
    });

    vi.spyOn(agent, "analyzeToken").mockResolvedValue(makeAnalysis("bitcoin", 0.3));

    await agent.analyzeAll();

    expect(mockJudge).not.toHaveBeenCalled();
    expect(mockLogSignal).toHaveBeenCalledOnce();
    const [, , , judgeData] = mockLogSignal.mock.calls[0]!;
    expect(judgeData).toBeUndefined();
  });
});
