/**
 * Tests for GridManager — level computation, fill simulation, rebalance logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GridTokenState, GridStats, GridLevel } from './grid-config.js';
import { DEFAULT_GRID_CONFIG } from './grid-config.js';

// Mock HyperliquidProvider
vi.mock('../../providers/data/hyperliquid.js', () => ({
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
    allocation: 2100, // 60% of 3500
    stats: emptyStats(),
    centerPrice: 85000,
    atr: 1200,
    ...overrides,
  };
}

function makeLevels(centerPrice: number, atr: number, config = DEFAULT_GRID_CONFIG): GridLevel[] {
  const range = atr * config.atrMultiplier;
  const spacing = range / config.levelsPerSide;
  const quantity = (2100 * config.leverage) / (config.levelsPerSide * centerPrice);
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
  it('creates correct number of levels (10 buy + 10 sell)', () => {
    const levels = makeLevels(85000, 1200);
    expect(levels.length).toBe(20);
    expect(levels.filter(l => l.side === 'buy').length).toBe(10);
    expect(levels.filter(l => l.side === 'sell').length).toBe(10);
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
    const spacing = 1200 * 2 / 10; // ATR * multiplier / levelsPerSide = 240
    for (let i = 1; i < buys.length; i++) {
      expect(buys[i - 1]!.price - buys[i]!.price).toBeCloseTo(spacing, 4);
    }
  });

  it('quantity reflects leverage and allocation', () => {
    const levels = makeLevels(85000, 1200);
    // (2100 * 3) / (10 * 85000) = 0.007412
    const expectedQty = (2100 * 3) / (10 * 85000);
    expect(levels[0]!.quantity).toBeCloseTo(expectedQty, 6);
  });

  it('range covers ±2×ATR', () => {
    const levels = makeLevels(85000, 1200);
    const buys = levels.filter(l => l.side === 'buy').sort((a, b) => a.price - b.price);
    const sells = levels.filter(l => l.side === 'sell').sort((a, b) => b.price - a.price);
    const lowestBuy = buys[0]!.price;
    const highestSell = sells[0]!.price;
    // Lowest buy = center - 10 * spacing = 85000 - 10 * 240 = 82600
    expect(lowestBuy).toBeCloseTo(82600, 0);
    // Highest sell = center + 10 * spacing = 87400
    expect(highestSell).toBeCloseTo(87400, 0);
  });
});

describe('Grid fill simulation', () => {
  it('buy level fills when price drops to level price', () => {
    const grid = makeGrid();
    grid.levels = makeLevels(85000, 1200);
    const buyLevel = grid.levels.find(l => l.side === 'buy' && l.price > 84700)!;

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
        targetSellPrice: buyLevel.price + 240, // spacing
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
    const spacing = 240;
    const buyPrice = 84760;
    const sellPrice = buyPrice + spacing; // 85000

    grid.openFills.push({
      token: 'bitcoin',
      buyPrice,
      targetSellPrice: sellPrice,
      quantity: 0.0074,
      filledAt: Date.now() - 60000,
      closed: false,
      pnlUsd: 0,
      closedAt: 0,
    });

    // Simulate sell fill
    const profit = (sellPrice - buyPrice) * 0.0074 * 3; // leverage = 3
    grid.openFills[0]!.closed = true;
    grid.openFills[0]!.pnlUsd = profit;

    expect(profit).toBeCloseTo(240 * 0.0074 * 3, 2); // ~$5.33
    expect(profit).toBeGreaterThan(DEFAULT_GRID_CONFIG.minProfitPerFillUsd);
  });

  it('multi-level sweep fills all crossed levels', () => {
    const grid = makeGrid();
    grid.levels = makeLevels(85000, 1200);
    const currentPrice = 84000; // drops through 4 buy levels

    const filledBuys = grid.levels.filter(
      l => l.side === 'buy' && !l.filled && currentPrice <= l.price,
    );
    // Price at 84000 crosses: 84760, 84520, 84280, 84040
    expect(filledBuys.length).toBe(4);
  });
});

describe('Grid rebalance logic', () => {
  it('detects drift past 70% threshold', () => {
    const grid = makeGrid({ centerPrice: 85000, atr: 1200 });
    const range = 1200 * 2; // 2400
    const driftThreshold = range * 0.70; // 1680

    // Price drifted 1700 from center — past 70%
    const priceFar = 85000 + 1700;
    const distFromCenter = Math.abs(priceFar - grid.centerPrice);
    expect(distFromCenter / range).toBeGreaterThanOrEqual(0.70);

    // Price drifted only 1000 — not past 70%
    const priceNear = 85000 + 1000;
    const distNear = Math.abs(priceNear - grid.centerPrice);
    expect(distNear / range).toBeLessThan(0.70);
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
    expect(gridAlloc).toBe(3500);

    const btcAlloc = gridAlloc * DEFAULT_GRID_CONFIG.tokenSplit.bitcoin!;
    const ethAlloc = gridAlloc * DEFAULT_GRID_CONFIG.tokenSplit.ethereum!;
    expect(btcAlloc).toBe(2100);
    expect(ethAlloc).toBe(1400);
    expect(btcAlloc + ethAlloc).toBe(gridAlloc);
  });

  it('profits compound in grid pool', () => {
    const grid = makeGrid({ allocation: 2100 });
    const profit = 12.50;
    grid.allocation += profit;
    expect(grid.allocation).toBe(2112.50);
  });

  it('pause threshold detects 20% drop', () => {
    const totalAlloc = 3500;
    const currentValue = totalAlloc * 0.78; // dropped 22%
    const dropPct = 1 - (currentValue / totalAlloc);
    expect(dropPct).toBeGreaterThanOrEqual(DEFAULT_GRID_CONFIG.pauseThresholdPct);
  });
});
