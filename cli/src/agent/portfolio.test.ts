/**
 * Unit tests for PortfolioTracker — PnL resets, file persistence, validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetPnlCounters, PortfolioTracker } from "./portfolio.js";
import type { PortfolioState } from "./risk.js";

// ── resetPnlCounters (pure function, no mocks needed) ──

describe("resetPnlCounters", () => {
  it("resets daily PnL when lastDailyReset is before today midnight UTC", () => {
    const yesterdayMs = Date.now() - 48 * 60 * 60 * 1000;
    const state: PortfolioState = {
      totalValue: 10000,
      positions: [],
      cash: 10000,
      dailyPnl: -250,
      weeklyPnl: -500,
      monthlyPnl: -800,
      lastDailyReset: yesterdayMs,
      lastWeeklyReset: Date.now(), // recent enough
      lastMonthlyReset: Date.now(),
    };

    const result = resetPnlCounters(state);
    expect(result.dailyPnl).toBe(0);
    expect(result.lastDailyReset).toBeGreaterThan(yesterdayMs);
  });

  it("does not reset daily PnL when already reset today", () => {
    const now = Date.now();
    const state: PortfolioState = {
      totalValue: 10000,
      positions: [],
      cash: 10000,
      dailyPnl: -150,
      weeklyPnl: 0,
      monthlyPnl: 0,
      lastDailyReset: now, // just reset
      lastWeeklyReset: now,
      lastMonthlyReset: now,
    };

    const result = resetPnlCounters(state);
    // Daily PnL should remain untouched since lastDailyReset is >= today midnight
    expect(result.dailyPnl).toBe(-150);
  });

  it("resets daily PnL when lastDailyReset is undefined", () => {
    const state: PortfolioState = {
      totalValue: 10000,
      positions: [],
      cash: 10000,
      dailyPnl: -300,
      weeklyPnl: 0,
      monthlyPnl: 0,
      // no lastDailyReset set
    };

    const result = resetPnlCounters(state);
    expect(result.dailyPnl).toBe(0);
    expect(result.lastDailyReset).toBeDefined();
    expect(result.lastDailyReset).toBeGreaterThan(0);
  });

  it("does not mutate the original state object", () => {
    const state: PortfolioState = {
      totalValue: 5000,
      positions: [],
      cash: 5000,
      dailyPnl: -100,
      weeklyPnl: -200,
      monthlyPnl: -300,
    };
    const original = { ...state };
    resetPnlCounters(state);
    expect(state.dailyPnl).toBe(original.dailyPnl);
    expect(state.weeklyPnl).toBe(original.weeklyPnl);
    expect(state.monthlyPnl).toBe(original.monthlyPnl);
  });

  it("resets weekly PnL when lastWeeklyReset is before this Monday UTC", () => {
    // Set lastWeeklyReset to 10 days ago (guaranteed to be before this Monday)
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const state: PortfolioState = {
      totalValue: 10000,
      positions: [],
      cash: 10000,
      dailyPnl: 0,
      weeklyPnl: -700,
      monthlyPnl: 0,
      lastDailyReset: Date.now(),
      lastWeeklyReset: tenDaysAgo,
      lastMonthlyReset: Date.now(),
    };

    const result = resetPnlCounters(state);
    expect(result.weeklyPnl).toBe(0);
    expect(result.lastWeeklyReset).toBeGreaterThan(tenDaysAgo);
  });

  it("resets monthly PnL when lastMonthlyReset is before 1st of this month UTC", () => {
    // Set lastMonthlyReset to 40 days ago (guaranteed to be before 1st of month)
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const state: PortfolioState = {
      totalValue: 10000,
      positions: [],
      cash: 10000,
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: -1500,
      lastDailyReset: Date.now(),
      lastWeeklyReset: Date.now(),
      lastMonthlyReset: fortyDaysAgo,
    };

    const result = resetPnlCounters(state);
    expect(result.monthlyPnl).toBe(0);
    expect(result.lastMonthlyReset).toBeGreaterThan(fortyDaysAgo);
  });
});

// ── PortfolioTracker.load() with mocked filesystem ──

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

import { readFile } from "node:fs/promises";
const mockReadFile = vi.mocked(readFile);

describe("PortfolioTracker.load", () => {
  let tracker: PortfolioTracker;

  beforeEach(() => {
    tracker = new PortfolioTracker();
    vi.clearAllMocks();
  });

  it("returns defaults when portfolio file is missing", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("ENOENT: no such file"));
    const state = await tracker.load();
    expect(state.totalValue).toBe(10000);
    expect(state.cash).toBe(10000);
    expect(state.positions).toEqual([]);
    expect(state.dailyPnl).toBe(0);
  });

  it("returns defaults when file contains invalid JSON", async () => {
    mockReadFile.mockResolvedValueOnce("not valid json {{{");
    const state = await tracker.load();
    expect(state.totalValue).toBe(10000);
    expect(state.positions).toEqual([]);
  });

  it("rejects corrupted data with Infinity totalValue", async () => {
    const corrupted = {
      totalValue: Infinity,
      positions: [],
      cash: 5000,
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: 0,
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(corrupted));
    const state = await tracker.load();
    // Should fall back to defaults due to !Number.isFinite check
    expect(state.totalValue).toBe(10000);
  });

  it("rejects corrupted data with negative cash", async () => {
    const corrupted = {
      totalValue: 5000,
      positions: [],
      cash: -100,
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: 0,
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(corrupted));
    const state = await tracker.load();
    expect(state.totalValue).toBe(10000); // defaults
    expect(state.cash).toBe(10000);
  });

  it("rejects corrupted data with non-array positions", async () => {
    const corrupted = {
      totalValue: 5000,
      positions: "not an array",
      cash: 5000,
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: 0,
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(corrupted));
    const state = await tracker.load();
    expect(state.totalValue).toBe(10000);
    expect(state.positions).toEqual([]);
  });

  it("rejects data with invalid position entry (zero entryPrice)", async () => {
    const invalid = {
      totalValue: 10000,
      positions: [
        {
          tokenId: "bitcoin",
          symbol: "BTC",
          entryPrice: 0, // invalid
          currentPrice: 50000,
          quantity: 1,
          entryTimestamp: Date.now(),
          stopLoss: 45000,
          takeProfit: 55000,
          strategy: "momentum",
          pnlPercent: 0,
          pnlUsd: 0,
        },
      ],
      cash: 5000,
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: 0,
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(invalid));
    const state = await tracker.load();
    expect(state.totalValue).toBe(10000); // defaults
    expect(state.positions).toEqual([]);
  });

  it("rejects data with invalid position entry (negative quantity)", async () => {
    const invalid = {
      totalValue: 10000,
      positions: [
        {
          tokenId: "bitcoin",
          symbol: "BTC",
          entryPrice: 50000,
          currentPrice: 50000,
          quantity: -1, // invalid
          entryTimestamp: Date.now(),
          stopLoss: 45000,
          takeProfit: 55000,
          strategy: "momentum",
          pnlPercent: 0,
          pnlUsd: 0,
        },
      ],
      cash: 5000,
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: 0,
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(invalid));
    const state = await tracker.load();
    expect(state.totalValue).toBe(10000);
    expect(state.positions).toEqual([]);
  });

  it("accepts and loads valid portfolio data", async () => {
    const valid = {
      totalValue: 12500,
      positions: [
        {
          tokenId: "bitcoin",
          symbol: "BTC",
          entryPrice: 50000,
          currentPrice: 52000,
          quantity: 0.05,
          entryTimestamp: Date.now() - 86400000,
          stopLoss: 47000,
          takeProfit: 60000,
          strategy: "momentum",
          pnlPercent: 0.04,
          pnlUsd: 100,
        },
      ],
      cash: 9900,
      dailyPnl: 100,
      weeklyPnl: 250,
      monthlyPnl: 500,
    };
    mockReadFile.mockResolvedValueOnce(JSON.stringify(valid));
    const state = await tracker.load();
    expect(state.totalValue).toBe(12500);
    expect(state.cash).toBe(9900);
    expect(state.positions).toHaveLength(1);
    expect(state.positions[0]!.tokenId).toBe("bitcoin");
    expect(state.positions[0]!.entryPrice).toBe(50000);
    expect(state.dailyPnl).toBe(100);
    expect(state.weeklyPnl).toBe(250);
    expect(state.monthlyPnl).toBe(500);
  });

  it("rejects data where dailyPnl is NaN", async () => {
    const corrupted = {
      totalValue: 10000,
      positions: [],
      cash: 10000,
      dailyPnl: NaN,
      weeklyPnl: 0,
      monthlyPnl: 0,
    };
    // NaN does not survive JSON.stringify — it becomes null,
    // but Number.isFinite(null) is false, so validation catches it
    mockReadFile.mockResolvedValueOnce(
      '{"totalValue":10000,"positions":[],"cash":10000,"dailyPnl":null,"weeklyPnl":0,"monthlyPnl":0}',
    );
    const state = await tracker.load();
    expect(state.totalValue).toBe(10000); // defaults
    expect(state.dailyPnl).toBe(0);
  });
});
