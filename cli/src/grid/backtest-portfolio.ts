/**
 * In-memory portfolio for backtest replays.
 *
 * Subclasses GridPortfolio to inherit the live state-shape semantics
 * (initialize, getState, checkPauseThreshold, aggregateStats) while
 * overriding load/save to skip disk I/O and resetDailyStats to use a
 * backtest clock instead of Date.now().
 */

import { GridPortfolio } from './portfolio.js';
import type { GridPortfolioState } from './config.js';

export class BacktestPortfolio extends GridPortfolio {
  private nowProvider: () => number;
  private inMemoryState: GridPortfolioState | null = null;

  constructor(nowProvider: () => number) {
    super();
    this.nowProvider = nowProvider;
  }

  /** Override: never read from disk. Returns the in-memory state. */
  override async load(): Promise<GridPortfolioState | null> {
    return this.inMemoryState;
  }

  /** Override: never write to disk. Stores the state in memory. */
  override async save(state: GridPortfolioState): Promise<void> {
    this.inMemoryState = state;
  }

  /** Override: read in-memory state instead of parent's private field. */
  override getState(): GridPortfolioState | null {
    return this.inMemoryState;
  }

  /** Override: use the injected clock instead of Date.now(). */
  override resetDailyStats(state: GridPortfolioState): boolean {
    return super.resetDailyStats(state, this.nowProvider());
  }
}
