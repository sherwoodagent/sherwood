/**
 * Grid portfolio — isolated capital tracking and disk persistence.
 *
 * Separate from the directional portfolio.json. Grid profits compound
 * in the grid pool; directional never touches grid capital.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { GridPortfolioState, GridTokenState, GridStats, GridConfig } from './config.js';

const GRID_STATE_PATH = join(homedir(), '.sherwood', 'grid', 'portfolio.json');

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

  /** Load grid state from disk. Returns null if no grid initialized yet. */
  async load(): Promise<GridPortfolioState | null> {
    try {
      const raw = await readFile(GRID_STATE_PATH, 'utf-8');
      this.state = JSON.parse(raw) as GridPortfolioState;
      return this.state;
    } catch {
      return null;
    }
  }

  /** Save grid state to disk (atomic write). */
  async save(state: GridPortfolioState): Promise<void> {
    this.state = state;
    await mkdir(dirname(GRID_STATE_PATH), { recursive: true });
    const tmp = `${GRID_STATE_PATH}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
    await rename(tmp, GRID_STATE_PATH);
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

  /** Reset daily counters if UTC day boundary crossed. */
  resetDailyStats(state: GridPortfolioState): boolean {
    const now = Date.now();
    const todayMidnight = new Date();
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

  /** Check if grid should be paused (pool dropped below threshold). */
  checkPauseThreshold(state: GridPortfolioState, config: GridConfig): boolean {
    const currentValue = state.grids.reduce((sum, g) => {
      const openFillValue = g.openFills
        .filter(f => !f.closed)
        .reduce((s, f) => s + f.quantity * f.buyPrice, 0);
      return sum + g.allocation + openFillValue;
    }, 0);

    const dropPct = 1 - (currentValue / state.totalAllocation);

    if (dropPct >= config.pauseThresholdPct) {
      state.paused = true;
      state.pauseReason = `Grid pool dropped ${(dropPct * 100).toFixed(1)}% (threshold: ${(config.pauseThresholdPct * 100).toFixed(0)}%)`;
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
