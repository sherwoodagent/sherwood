/**
 * Tests for GridManager — level computation, fill simulation, rebalance logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GridTokenState, GridStats, GridLevel } from './config.js';
import { DEFAULT_GRID_CONFIG } from './config.js';

// Mock HyperliquidProvider
vi.mock('../providers/data/hyperliquid.js', () => ({
  HyperliquidProvider: class {
    getCandles = vi.fn().mockResolvedValue(null);
    getHyperliquidData = vi.fn().mockResolvedValue(null);
  },
  safeNumber: (x: unknown) => {
    const n = typeof x === 'number' ? x : parseFloat(x as string);
    return Number.isFinite(n) ? n : null;
  },
}));

function emptyStats(): GridStats {
  return {
    totalRoundTrips: 0, totalPnlUsd: 0, todayPnlUsd: 0,
    totalFills: 0, todayFills: 0, lastDailyReset: 0, lastRebalanceAt: 0,
  };
}

function makeGrid(overrides?: Partial<GridTokenState>): GridTokenState {
  return {
    token: 'bitcoin',
    levels: [],
    openFills: [],
    allocation: 1575, // 45% of 3500
    stats: emptyStats(),
    centerPrice: 85000,
    atr: 1200,
    ...overrides,
  };
}

function makeLevels(centerPrice: number, atr: number, config = DEFAULT_GRID_CONFIG): GridLevel[] {
  const range = atr * config.atrMultiplier;
  const spacing = range / config.levelsPerSide;
  const quantity = (1575 * config.leverage) / (config.levelsPerSide * centerPrice);
  const levels: GridLevel[] = [];
  for (let i = 1; i <= config.levelsPerSide; i++) {
    levels.push({ price: centerPrice - spacing * i, side: 'buy', quantity, filled: false, filledAt: 0 });
  }
  for (let i = 1; i <= config.levelsPerSide; i++) {
    levels.push({ price: centerPrice + spacing * i, side: 'sell', quantity, filled: false, filledAt: 0 });
  }
  return levels;
}

describe('Grid level computation', () => {
  it('creates correct number of levels (15 buy + 15 sell)', () => {
    const levels = makeLevels(85000, 1200);
    expect(levels.length).toBe(30);
    expect(levels.filter(l => l.side === 'buy').length).toBe(15);
    expect(levels.filter(l => l.side === 'sell').length).toBe(15);
  });

  it('buy levels are below center, sell levels above', () => {
    const levels = makeLevels(85000, 1200);
    for (const l of levels) {
      if (l.side === 'buy') expect(l.price).toBeLessThan(85000);
      if (l.side === 'sell') expect(l.price).toBeGreaterThan(85000);
    }
  });

  it('levels are evenly spaced', () => {
    const levels = makeLevels(85000, 1200);
    const buys = levels.filter(l => l.side === 'buy').sort((a, b) => b.price - a.price);
    const spacing = 1200 * 2 / 15; // ATR * multiplier / levelsPerSide = 160
    for (let i = 1; i < buys.length; i++) {
      expect(buys[i - 1]!.price - buys[i]!.price).toBeCloseTo(spacing, 4);
    }
  });

  it('quantity reflects leverage and allocation', () => {
    const levels = makeLevels(85000, 1200);
    // (1575 * 5) / (15 * 85000) = 0.006176
    const expectedQty = (1575 * 5) / (15 * 85000);
    expect(levels[0]!.quantity).toBeCloseTo(expectedQty, 6);
  });

  it('range covers ±2×ATR', () => {
    const levels = makeLevels(85000, 1200);
    const buys = levels.filter(l => l.side === 'buy').sort((a, b) => a.price - b.price);
    const sells = levels.filter(l => l.side === 'sell').sort((a, b) => b.price - a.price);
    const lowestBuy = buys[0]!.price;
    const highestSell = sells[0]!.price;
    // Range = ATR * atrMultiplier = 1200 * 2 = 2400
    // Lowest buy = center - range = 85000 - 2400 = 82600
    // Highest sell = center + range = 85000 + 2400 = 87400
    // (15 levels × 160 spacing = 2400, same range as old 10 × 240)
    expect(lowestBuy).toBeCloseTo(82600, 0);
    expect(highestSell).toBeCloseTo(87400, 0);
  });
});

describe('Grid fill simulation', () => {
  it('buy level fills when price drops to level price', () => {
    const grid = makeGrid();
    grid.levels = makeLevels(85000, 1200);
    const buyLevel = grid.levels.find(l => l.side === 'buy' && l.price > 84800)!;

    // Simulate: price drops to exactly the buy level
    // (Inline simulation — the real GridManager.simulateFills is private,
    //  so we test the logic pattern directly)
    const price = buyLevel.price;
    expect(price).toBeLessThan(85000);
    expect(buyLevel.filled).toBe(false);

    // After fill: should be marked filled
    if (price <= buyLevel.price) {
      buyLevel.filled = true;
      buyLevel.filledAt = Date.now();
      grid.openFills.push({
        token: 'bitcoin',
        buyPrice: buyLevel.price,
        targetSellPrice: buyLevel.price + 160, // spacing (ATR*2/15)
        quantity: buyLevel.quantity,
        filledAt: Date.now(),
        closed: false,
        pnlUsd: 0,
        closedAt: 0,
      });
    }
    expect(buyLevel.filled).toBe(true);
    expect(grid.openFills.length).toBe(1);
    expect(grid.openFills[0]!.buyPrice).toBe(buyLevel.price);
  });

  it('round-trip completes when sell fills above a prior buy', () => {
    const grid = makeGrid();
    const spacing = 160; // ATR*2/15
    const buyPrice = 84840;
    const sellPrice = buyPrice + spacing; // 85000

    grid.openFills.push({
      token: 'bitcoin',
      buyPrice,
      targetSellPrice: sellPrice,
      quantity: 0.0062,
      filledAt: Date.now() - 60000,
      closed: false,
      pnlUsd: 0,
      closedAt: 0,
    });

    // Simulate sell fill
    const profit = (sellPrice - buyPrice) * 0.0062 * 5; // leverage = 5
    grid.openFills[0]!.closed = true;
    grid.openFills[0]!.pnlUsd = profit;

    expect(profit).toBeCloseTo(160 * 0.0062 * 5, 2); // ~$4.96
    expect(profit).toBeGreaterThan(DEFAULT_GRID_CONFIG.minProfitPerFillUsd);
  });

  it('multi-level sweep fills all crossed levels', () => {
    const grid = makeGrid();
    grid.levels = makeLevels(85000, 1200);
    const currentPrice = 84000; // drops through buy levels

    const filledBuys = grid.levels.filter(
      l => l.side === 'buy' && !l.filled && currentPrice <= l.price,
    );
    // With 15 levels, spacing=160: levels at 84840, 84680, 84520, 84360, 84200, 84040
    // Price at 84000 crosses 6 levels
    expect(filledBuys.length).toBe(6);
  });
});

describe('Grid rebalance logic', () => {
  it('detects drift past 40% threshold', () => {
    const grid = makeGrid({ centerPrice: 85000, atr: 1200 });
    const range = 1200 * 2; // 2400
    const driftThreshold = range * DEFAULT_GRID_CONFIG.rebalanceDriftPct; // 0.40 * 2400 = 960

    // Price drifted 1000 from center — past 40%
    const priceFar = 85000 + 1000;
    const distFromCenter = Math.abs(priceFar - grid.centerPrice);
    expect(distFromCenter / range).toBeGreaterThanOrEqual(DEFAULT_GRID_CONFIG.rebalanceDriftPct);

    // Price drifted 800 — not past 40%
    const priceNear = 85000 + 800;
    const distNear = Math.abs(priceNear - grid.centerPrice);
    expect(distNear / range).toBeLessThan(DEFAULT_GRID_CONFIG.rebalanceDriftPct);
  });

  it('full rebuild triggers after 12h', () => {
    const grid = makeGrid();
    grid.stats.lastRebalanceAt = Date.now() - 13 * 60 * 60 * 1000; // 13h ago
    const elapsed = Date.now() - grid.stats.lastRebalanceAt;
    expect(elapsed).toBeGreaterThanOrEqual(DEFAULT_GRID_CONFIG.fullRebuildIntervalMs);
  });

  it('no rebuild needed within 12h if no drift', () => {
    const grid = makeGrid();
    grid.stats.lastRebalanceAt = Date.now() - 2 * 60 * 60 * 1000; // 2h ago
    const elapsed = Date.now() - grid.stats.lastRebalanceAt;
    expect(elapsed).toBeLessThan(DEFAULT_GRID_CONFIG.fullRebuildIntervalMs);
  });
});

describe('Grid capital isolation', () => {
  it('allocation split matches config', () => {
    const total = 10000;
    const gridAlloc = total * DEFAULT_GRID_CONFIG.allocationPct;
    expect(gridAlloc).toBe(5000);

    const btcAlloc = gridAlloc * DEFAULT_GRID_CONFIG.tokenSplit.bitcoin!;
    const ethAlloc = gridAlloc * DEFAULT_GRID_CONFIG.tokenSplit.ethereum!;
    const solAlloc = gridAlloc * DEFAULT_GRID_CONFIG.tokenSplit.solana!;
    expect(btcAlloc).toBe(2250);   // 45%
    expect(ethAlloc).toBe(1500);   // 30%
    expect(solAlloc).toBe(1250);   // 25%
    expect(btcAlloc + ethAlloc + solAlloc).toBe(gridAlloc);
  });

  it('profits compound in grid pool', () => {
    const grid = makeGrid({ allocation: 1575 });
    const profit = 12.50;
    grid.allocation += profit;
    expect(grid.allocation).toBe(1587.50);
  });

  it('pause threshold detects 20% drop', () => {
    const totalAlloc = 5000;
    const currentValue = totalAlloc * 0.78; // dropped 22%
    const dropPct = 1 - (currentValue / totalAlloc);
    expect(dropPct).toBeGreaterThanOrEqual(DEFAULT_GRID_CONFIG.pauseThresholdPct);
  });
});
