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

  it("resets dailyEntries when crossing UTC midnight (Orca-inspired daily cap)", () => {
    const yesterdayMs = Date.now() - 48 * 60 * 60 * 1000;
    const state: PortfolioState = {
      totalValue: 10000,
      positions: [],
      cash: 10000,
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: 0,
      dailyEntries: 7,
      lastDailyEntriesReset: yesterdayMs,
      lastDailyReset: Date.now(),
    };
    const result = resetPnlCounters(state);
    expect(result.dailyEntries).toBe(0);
    expect(result.lastDailyEntriesReset).toBeGreaterThan(yesterdayMs);
  });

  it("preserves dailyEntries within the same UTC day", () => {
    const now = Date.now();
    const state: PortfolioState = {
      totalValue: 10000,
      positions: [],
      cash: 10000,
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: 0,
      dailyEntries: 3,
      lastDailyEntriesReset: now,
      lastDailyReset: now,
    };
    const result = resetPnlCounters(state);
    expect(result.dailyEntries).toBe(3);
  });

  it("initializes dailyEntries when lastDailyEntriesReset is undefined (legacy file)", () => {
    const state: PortfolioState = {
      totalValue: 10000,
      positions: [],
      cash: 10000,
      dailyPnl: 0,
      weeklyPnl: 0,
      monthlyPnl: 0,
      // no dailyEntries / lastDailyEntriesReset — simulates pre-upgrade portfolio.json
    };
    const result = resetPnlCounters(state);
    expect(result.dailyEntries).toBe(0);
    expect(result.lastDailyEntriesReset).toBeDefined();
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

describe("PortfolioTracker.addToPosition", () => {
  // Tests use a stateful in-memory mock filesystem so subsequent load()
  // calls within a single test see the writes from the prior operation.
  // Each test creates its own tracker + backing state — the existing
  // module-level mock for `node:fs/promises` is shared across all
  // describe blocks in this file, so we use mockResolvedValueOnce /
  // explicit chaining rather than long-lived implementations.
  function setupBacking() {
    const backing = { state: null as string | null };
    mockReadFile.mockImplementation(async () => {
      if (backing.state === null) throw new Error("ENOENT: no such file");
      return backing.state;
    });
    return backing;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const { writeFile, rename, mkdir } = await import("node:fs/promises");
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("computes a quantity-weighted average entry price", async () => {
    const backing = setupBacking();
    const { writeFile } = await import("node:fs/promises");
    vi.mocked(writeFile).mockImplementation(async (_p: any, data: any) => {
      backing.state = typeof data === "string" ? data : data.toString();
    });
    const tracker = new PortfolioTracker();

    // Open base long: 10 BTC at $100.
    await tracker.openPosition({
      tokenId: "bitcoin", symbol: "BTC", side: "long",
      entryPrice: 100, currentPrice: 100, quantity: 10,
      entryTimestamp: Date.now() - 5 * 60 * 60 * 1000,
      stopLoss: 97, takeProfit: 106, strategy: "test",
    });

    // Pyramid: add 5 BTC at $110.
    // Weighted average = (100*10 + 110*5) / 15 = 1550/15 = 103.333...
    const updated = await tracker.addToPosition("bitcoin", 110, 5, "long");
    expect(updated.quantity).toBe(15);
    expect(updated.entryPrice).toBeCloseTo(103.333, 3);
    expect(updated.addCount).toBe(1);
    expect(updated.lastAddTimestamp).toBeGreaterThan(updated.entryTimestamp);
    // Stops/TPs preserved from base position
    expect(updated.stopLoss).toBe(97);
    expect(updated.takeProfit).toBe(106);
  });

  it("rejects opposite-direction add", async () => {
    const backing = setupBacking();
    const { writeFile } = await import("node:fs/promises");
    vi.mocked(writeFile).mockImplementation(async (_p: any, data: any) => {
      backing.state = typeof data === "string" ? data : data.toString();
    });
    const tracker = new PortfolioTracker();
    await tracker.openPosition({
      tokenId: "bitcoin", symbol: "BTC", side: "long",
      entryPrice: 100, currentPrice: 100, quantity: 10,
      entryTimestamp: Date.now(),
      stopLoss: 97, takeProfit: 106, strategy: "test",
    });
    await expect(tracker.addToPosition("bitcoin", 100, 1, "short")).rejects.toThrow(/Cannot pyramid/);
  });

  it("rejects add when no existing position", async () => {
    // Force load() to see an empty portfolio (no positions array entries).
    // Use mockResolvedValueOnce so this test's response is consumed
    // immediately and doesn't interact with neighboring tests' impls.
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      totalValue: 10000, cash: 10000, positions: [],
      dailyPnl: 0, weeklyPnl: 0, monthlyPnl: 0,
    }));
    const tracker = new PortfolioTracker();
    await expect(tracker.addToPosition("bitcoin", 100, 1, "long")).rejects.toThrow(/No open position/);
  });

  it("rejects add with non-positive quantity or price (pre-load checks)", async () => {
    setupBacking();
    const tracker = new PortfolioTracker();
    await expect(tracker.addToPosition("bitcoin", 100, 0, "long")).rejects.toThrow(/Invalid add quantity/);
    await expect(tracker.addToPosition("bitcoin", 100, -1, "long")).rejects.toThrow(/Invalid add quantity/);
    await expect(tracker.addToPosition("bitcoin", 0, 1, "long")).rejects.toThrow(/Invalid add price/);
  });
});

describe("PortfolioTracker.openPosition (Orca-inspired fields)", () => {
  function setupBacking() {
    const backing = { state: null as string | null };
    mockReadFile.mockImplementation(async () => {
      if (backing.state === null) throw new Error("ENOENT: no such file");
      return backing.state;
    });
    return backing;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const { writeFile, rename, mkdir } = await import("node:fs/promises");
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("seeds peakPrice at entryPrice on open (HWM profit-lock)", async () => {
    const backing = setupBacking();
    const { writeFile } = await import("node:fs/promises");
    vi.mocked(writeFile).mockImplementation(async (_p: any, data: any) => {
      backing.state = typeof data === "string" ? data : data.toString();
    });
    const tracker = new PortfolioTracker();
    const pos = await tracker.openPosition({
      tokenId: "bitcoin", symbol: "BTC", side: "long",
      entryPrice: 100, currentPrice: 100, quantity: 10,
      entryTimestamp: Date.now(),
      stopLoss: 95, takeProfit: 110, strategy: "test",
    });
    expect(pos.peakPrice).toBe(100);
  });

  it("increments dailyEntries on each new position (daily cap counter)", async () => {
    const backing = setupBacking();
    const { writeFile } = await import("node:fs/promises");
    vi.mocked(writeFile).mockImplementation(async (_p: any, data: any) => {
      backing.state = typeof data === "string" ? data : data.toString();
    });
    const tracker = new PortfolioTracker();

    await tracker.openPosition({
      tokenId: "bitcoin", symbol: "BTC", side: "long",
      entryPrice: 100, currentPrice: 100, quantity: 1,
      entryTimestamp: Date.now(), stopLoss: 95, takeProfit: 110, strategy: "test",
    });
    let state = await tracker.load();
    expect(state.dailyEntries).toBe(1);

    await tracker.openPosition({
      tokenId: "ethereum", symbol: "ETH", side: "long",
      entryPrice: 2000, currentPrice: 2000, quantity: 1,
      entryTimestamp: Date.now(), stopLoss: 1900, takeProfit: 2100, strategy: "test",
    });
    state = await tracker.load();
    expect(state.dailyEntries).toBe(2);
  });

  it("pyramid adds via addToPosition do NOT increment dailyEntries", async () => {
    const backing = setupBacking();
    const { writeFile } = await import("node:fs/promises");
    vi.mocked(writeFile).mockImplementation(async (_p: any, data: any) => {
      backing.state = typeof data === "string" ? data : data.toString();
    });
    const tracker = new PortfolioTracker();

    await tracker.openPosition({
      tokenId: "bitcoin", symbol: "BTC", side: "long",
      entryPrice: 100, currentPrice: 100, quantity: 10,
      entryTimestamp: Date.now(), stopLoss: 97, takeProfit: 110, strategy: "test",
    });

    await tracker.addToPosition("bitcoin", 105, 5, "long");
    const state = await tracker.load();
    // still just the single new entry from openPosition
    expect(state.dailyEntries).toBe(1);
  });
});

describe("PortfolioTracker.closePartial", () => {
  // Tracks portfolio.json and trades.json separately so appendTradeRecord
  // doesn't accidentally parse the portfolio state as a trades array.
  function setupBacking() {
    const backing = { state: null as string | null, trades: null as string | null };
    mockReadFile.mockImplementation(async (path: any) => {
      const p = String(path);
      if (p.includes("trades")) {
        if (backing.trades === null) throw new Error("ENOENT: no such file");
        return backing.trades;
      }
      if (backing.state === null) throw new Error("ENOENT: no such file");
      return backing.state;
    });
    return backing;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const { writeFile, rename, mkdir } = await import("node:fs/promises");
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
  });

  it("reduces quantity by fraction and records trade", async () => {
    const backing = setupBacking();
    const { writeFile } = await import("node:fs/promises");
    vi.mocked(writeFile).mockImplementation(async (path: any, data: any) => {
      const content = typeof data === "string" ? data : data.toString();
      if (String(path).includes("trades")) {
        backing.trades = content;
      } else {
        backing.state = content;
      }
    });
    const tracker = new PortfolioTracker();

    await tracker.openPosition({
      tokenId: "bitcoin", symbol: "BTC", side: "long",
      entryPrice: 100, currentPrice: 120, quantity: 10,
      entryTimestamp: Date.now(),
      stopLoss: 97, takeProfit: 130, strategy: "test",
    });

    const result = await tracker.closePartial("bitcoin", 0.5, 120, "Partial profit");
    expect(result.quantityClosed).toBe(5);
    expect(result.pnlPercent).toBeCloseTo(0.20, 2); // (120-100)/100
    expect(result.pnl).toBeCloseTo(100, 0); // 20 * 5
  });

  it("sets partialTaken flag on remaining position", async () => {
    const backing = setupBacking();
    const { writeFile } = await import("node:fs/promises");
    vi.mocked(writeFile).mockImplementation(async (path: any, data: any) => {
      const content = typeof data === "string" ? data : data.toString();
      if (String(path).includes("trades")) {
        backing.trades = content;
      } else {
        backing.state = content;
      }
    });
    const tracker = new PortfolioTracker();

    await tracker.openPosition({
      tokenId: "ethereum", symbol: "ETH", side: "long",
      entryPrice: 2000, currentPrice: 2100, quantity: 1,
      entryTimestamp: Date.now(),
      stopLoss: 1940, takeProfit: 2200, strategy: "test",
    });

    await tracker.closePartial("ethereum", 0.5, 2100, "Partial profit");

    // Verify partialTaken by loading the persisted state
    const state = await tracker.load();
    const pos = state.positions.find((p) => p.tokenId === "ethereum");
    expect(pos).toBeDefined();
    expect(pos!.quantity).toBeCloseTo(0.5, 4);
    expect(pos!.partialTaken).toBe(true);
  });

  it("keeps totalValue on margin-equity accounting after partial close", async () => {
    const backing = setupBacking();
    const { writeFile } = await import("node:fs/promises");
    vi.mocked(writeFile).mockImplementation(async (path: any, data: any) => {
      const content = typeof data === "string" ? data : data.toString();
      if (String(path).includes("trades")) {
        backing.trades = content;
      } else {
        backing.state = content;
      }
    });
    const tracker = new PortfolioTracker();

    await tracker.openPosition({
      tokenId: "bitcoin", symbol: "BTC", side: "long",
      entryPrice: 100, currentPrice: 120, quantity: 10,
      entryTimestamp: Date.now(),
      stopLoss: 95, takeProfit: 130, strategy: "test",
    });

    await tracker.closePartial("bitcoin", 0.5, 120, "Partial profit");

    const state = await tracker.load();
    expect(state.cash).toBeCloseTo(9935, 2);
    expect(state.positions[0]!.quantity).toBeCloseTo(5, 4);
    // cash + remaining margin (5*100*0.33) + remaining unrealized PnL (5*20)
    expect(state.totalValue).toBeCloseTo(10200, 2);
  });

  it("rejects invalid fraction", async () => {
    const tracker = new PortfolioTracker();
    await expect(tracker.closePartial("bitcoin", 0, 100, "test")).rejects.toThrow(/Invalid fraction/);
    await expect(tracker.closePartial("bitcoin", 1, 100, "test")).rejects.toThrow(/Invalid fraction/);
    await expect(tracker.closePartial("bitcoin", 1.5, 100, "test")).rejects.toThrow(/Invalid fraction/);
  });

  it("rejects when no position exists", async () => {
    mockReadFile.mockResolvedValueOnce(JSON.stringify({
      totalValue: 10000, cash: 10000, positions: [],
      dailyPnl: 0, weeklyPnl: 0, monthlyPnl: 0,
    }));
    const tracker = new PortfolioTracker();
    await expect(tracker.closePartial("bitcoin", 0.5, 100, "test")).rejects.toThrow(/No open position/);
  });
});
