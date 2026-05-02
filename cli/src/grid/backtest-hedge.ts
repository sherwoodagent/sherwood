/**
 * In-memory hedge manager for backtest replays.
 *
 * Subclasses GridHedgeManager so the live tick() logic is reused verbatim;
 * only state I/O and the clock are redirected — load() returns an in-memory
 * state initialized with a backtest-driven `lastDailyReset`, and save() is
 * a no-op.
 */

import { GridHedgeManager, type HedgeState } from './hedge.js';

export class BacktestHedgeManager extends GridHedgeManager {
  private nowProvider: () => number;
  private inMemoryState: HedgeState | null = null;

  constructor(nowProvider: () => number) {
    super();
    this.nowProvider = nowProvider;
  }

  override async load(_now?: number): Promise<HedgeState> {
    if (this.inMemoryState) {
      // Manual daily-reset using injected clock
      const now = this.nowProvider();
      const todayMidnight = new Date(now);
      todayMidnight.setUTCHours(0, 0, 0, 0);
      if (this.inMemoryState.lastDailyReset < todayMidnight.getTime()) {
        this.inMemoryState.todayRealizedPnl = 0;
        this.inMemoryState.lastDailyReset = now;
      }
      // Keep parent's `state` field in sync so getStatus() works.
      (this as unknown as { state: HedgeState | null }).state = this.inMemoryState;
      return this.inMemoryState;
    }
    const now = this.nowProvider();
    this.inMemoryState = {
      positions: [],
      totalRealizedPnl: 0,
      todayRealizedPnl: 0,
      lastDailyReset: now,
    };
    (this as unknown as { state: HedgeState | null }).state = this.inMemoryState;
    return this.inMemoryState;
  }

  override async save(): Promise<void> {
    // no-op: state stays in memory
  }
}
