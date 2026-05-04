/**
 * Grid portfolio — isolated capital tracking and disk persistence.
 *
 * Separate from the directional portfolio.json. Grid profits compound
 * in the grid pool; directional never touches grid capital.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gridStatePath } from './paths.js';
import type { GridPortfolioState, GridTokenState, GridStats, GridConfig } from './config.js';

function emptyStats(): GridStats {
  return {
    totalRoundTrips: 0,
    totalPnlUsd: 0,
    todayPnlUsd: 0,
    totalFills: 0,
    todayFills: 0,
    lastDailyReset: 0,
    lastRebalanceAt: 0,
  };
}

export class GridPortfolio {
  private state: GridPortfolioState | null = null;
  private statePath: string;

  constructor(stateDir?: string) {
    this.statePath = gridStatePath('portfolio.json', stateDir);
  }

  /** Load grid state from disk. Returns null if no grid initialized yet. */
  async load(): Promise<GridPortfolioState | null> {
    try {
      const raw = await readFile(this.statePath, 'utf-8');
      this.state = JSON.parse(raw) as GridPortfolioState;
      return this.state;
    } catch {
      return null;
    }
  }

  /** Save grid state to disk (atomic write). */
  async save(state: GridPortfolioState): Promise<void> {
    this.state = state;
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await rename(tmp, this.statePath);
  }

  /**
   * Initialize the grid by carving capital from the directional portfolio.
   * Called once on first startup when grid-portfolio.json doesn't exist.
   *
   * Returns the USD amount carved out (caller must deduct from directional portfolio).
   */
  async initialize(capital: number, config: GridConfig): Promise<void> {
    const allocation = capital;

    const grids: GridTokenState[] = config.tokens.map(token => ({
      token,
      levels: [],
      openFills: [],
      allocation: allocation * (config.tokenSplit[token] ?? 1 / config.tokens.length),
      stats: emptyStats(),
      centerPrice: 0,
      atr: 0,
      trend: 0,
      lastTrendRefreshAt: 0,
    }));

    const state: GridPortfolioState = {
      totalAllocation: allocation,
      grids,
      paused: false,
      pauseReason: '',
      initializedAt: Date.now(),
    };

    await this.save(state);
    this.state = state;
  }

  /** Get current state (must load() first). */
  getState(): GridPortfolioState | null {
    return this.state;
  }

  /** Reset daily counters if UTC day boundary crossed. `now` is injectable
   *  so the backtester can drive resets off backtest time, not wall-clock. */
  resetDailyStats(state: GridPortfolioState, now: number = Date.now()): boolean {
    const todayMidnight = new Date(now);
    todayMidnight.setUTCHours(0, 0, 0, 0);
    const todayMs = todayMidnight.getTime();

    let changed = false;
    for (const grid of state.grids) {
      if (!grid.stats.lastDailyReset || grid.stats.lastDailyReset < todayMs) {
        grid.stats.todayPnlUsd = 0;
        grid.stats.todayFills = 0;
        grid.stats.lastDailyReset = now;
        changed = true;
      }
    }
    return changed;
  }

  /** Check if grid should be paused or resumed (pool equity dropped/recovered).
   *  `prices` is required to mark open buys to market. Hysteresis: pause at
   *  `pauseThresholdPct` drop, resume only when drop recovers below
   *  `unpauseRecoveryPct`. Returns true iff state.paused was changed. */
  checkPauseThreshold(
    state: GridPortfolioState,
    config: GridConfig,
    prices: Record<string, number>,
  ): boolean {
    const currentValue = state.grids.reduce((sum, g) => {
      const price = prices[g.token];
      // quantity already leveraged at build time — see manager.simulateFills.
      const unrealized = (price && price > 0)
        ? g.openFills
            .filter(f => !f.closed)
            .reduce((s, f) => s + (price - f.buyPrice) * f.quantity, 0)
        : 0;
      return sum + g.allocation + unrealized;
    }, 0);

    const dropPct = 1 - (currentValue / state.totalAllocation);

    if (!state.paused && dropPct >= config.pauseThresholdPct) {
      state.paused = true;
      state.pauseReason = `Grid pool dropped ${(dropPct * 100).toFixed(1)}% (pause threshold: ${(config.pauseThresholdPct * 100).toFixed(0)}%, resume when ≤ ${(config.unpauseRecoveryPct * 100).toFixed(0)}%)`;
      return true;
    }

    if (state.paused && dropPct <= config.unpauseRecoveryPct) {
      state.paused = false;
      state.pauseReason = '';
      return true;
    }

    return false;
  }

  /** Aggregate stats across all token grids. */
  aggregateStats(state: GridPortfolioState): {
    totalPnlUsd: number;
    todayPnlUsd: number;
    todayFills: number;
    totalRoundTrips: number;
  } {
    return {
      totalPnlUsd: state.grids.reduce((s, g) => s + g.stats.totalPnlUsd, 0),
      todayPnlUsd: state.grids.reduce((s, g) => s + g.stats.todayPnlUsd, 0),
      todayFills: state.grids.reduce((s, g) => s + g.stats.todayFills, 0),
      totalRoundTrips: state.grids.reduce((s, g) => s + g.stats.totalRoundTrips, 0),
    };
  }
}
