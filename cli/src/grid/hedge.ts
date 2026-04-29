/**
 * Grid Delta Hedge — maintains a partial short to offset underwater long fills.
 *
 * When the grid accumulates open buy fills (price dropped through buy levels),
 * the hedge opens a short position sized at HEDGE_RATIO of the total long exposure.
 * This limits drawdown during directional drops while preserving most grid profit
 * during ranging markets.
 *
 * Mechanics:
 *   - Each tick: compute total long exposure from open fills
 *   - Desired short = exposure × HEDGE_RATIO
 *   - If current hedge size differs by >10%, adjust
 *   - Track hedge PnL separately from grid PnL
 *   - Close hedge when open fills drop below threshold (price recovered)
 *
 * Cost analysis (30% hedge on $6,400 exposure):
 *   - Ranging drag: ~$8/day (5.6% of grid profit)
 *   - Funding income: ~$2/day (shorts earn when rate positive)
 *   - Net cost: ~$6/day — pays for itself on any >1.3% drop
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';

/** Fraction of grid long exposure to hedge with a short. */
const HEDGE_RATIO = 0.30;

/** Minimum number of open buy fills before hedge activates. */
const MIN_FILLS_TO_HEDGE = 3;

/** Don't adjust hedge unless size differs by more than this fraction. */
const ADJUSTMENT_THRESHOLD = 0.10;

const HEDGE_STATE_PATH = join(homedir(), '.sherwood', 'grid', 'hedge.json');

export interface HedgePosition {
  token: string;
  /** Short entry price (average, updates on adjustments). */
  entryPrice: number;
  /** Short quantity in token units. */
  quantity: number;
  /** Timestamp of last adjustment. */
  lastAdjustedAt: number;
  /** Cumulative realized PnL from hedge adjustments. */
  realizedPnl: number;
}

export interface HedgeState {
  positions: HedgePosition[];
  /** Total realized PnL across all hedge positions (including closed). */
  totalRealizedPnl: number;
  /** Today's realized PnL (resets daily). */
  todayRealizedPnl: number;
  lastDailyReset: number;
}

interface OpenFillExposure {
  token: string;
  totalQuantity: number;
  totalNotional: number;
  avgEntryPrice: number;
  fillCount: number;
}

export interface HedgeTickResult {
  /** Number of hedge adjustments made this tick. */
  adjustments: number;
  /** Unrealized PnL across all active hedge positions. */
  unrealizedPnl: number;
  /** Total realized PnL (cumulative). */
  totalRealizedPnl: number;
}

export class GridHedgeManager {
  private state: HedgeState | null = null;

  async load(): Promise<HedgeState> {
    if (this.state) return this.state;
    try {
      const raw = await readFile(HEDGE_STATE_PATH, 'utf-8');
      this.state = JSON.parse(raw) as HedgeState;
    } catch {
      this.state = {
        positions: [],
        totalRealizedPnl: 0,
        todayRealizedPnl: 0,
        lastDailyReset: Date.now(),
      };
    }

    // Reset daily PnL at UTC midnight
    const todayMidnight = new Date();
    todayMidnight.setUTCHours(0, 0, 0, 0);
    if (this.state.lastDailyReset < todayMidnight.getTime()) {
      this.state.todayRealizedPnl = 0;
      this.state.lastDailyReset = Date.now();
    }

    return this.state;
  }

  async save(): Promise<void> {
    if (!this.state) return;
    await mkdir(dirname(HEDGE_STATE_PATH), { recursive: true });
    const tmp = `${HEDGE_STATE_PATH}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, HEDGE_STATE_PATH);
  }

  /**
   * Run one hedge tick. Call after grid tick with current prices and open fill data.
   *
   * @param openFills - Per-token open fill exposure from the grid portfolio
   * @param prices - Current mark prices per token
   */
  async tick(
    openFills: OpenFillExposure[],
    prices: Record<string, number>,
  ): Promise<HedgeTickResult> {
    const state = await this.load();
    let adjustments = 0;
    let unrealizedPnl = 0;

    for (const fill of openFills) {
      const price = prices[fill.token];
      if (!price || price <= 0) continue;

      const desiredShortQty = fill.fillCount >= MIN_FILLS_TO_HEDGE
        ? fill.totalQuantity * HEDGE_RATIO
        : 0;

      const existing = state.positions.find(p => p.token === fill.token);

      if (desiredShortQty <= 0) {
        // Close hedge if one exists
        if (existing && existing.quantity > 0) {
          const closePnl = (existing.entryPrice - price) * existing.quantity;
          state.totalRealizedPnl += closePnl;
          state.todayRealizedPnl += closePnl;
          existing.realizedPnl += closePnl;
          console.error(chalk.yellow(
            `  [hedge] CLOSE ${fill.token} short ${existing.quantity.toFixed(6)} @ $${price.toFixed(2)} ` +
            `PnL: $${closePnl.toFixed(2)}`
          ));
          existing.quantity = 0;
          existing.entryPrice = 0;
          adjustments++;
        }
        continue;
      }

      if (!existing) {
        // Open new hedge
        state.positions.push({
          token: fill.token,
          entryPrice: price,
          quantity: desiredShortQty,
          lastAdjustedAt: Date.now(),
          realizedPnl: 0,
        });
        console.error(chalk.magenta(
          `  [hedge] OPEN ${fill.token} short ${desiredShortQty.toFixed(6)} @ $${price.toFixed(2)} ` +
          `(${(HEDGE_RATIO * 100).toFixed(0)}% of ${fill.fillCount} open fills)`
        ));
        adjustments++;
      } else if (existing.quantity > 0) {
        // Check if adjustment needed
        const diff = Math.abs(desiredShortQty - existing.quantity) / existing.quantity;
        if (diff > ADJUSTMENT_THRESHOLD) {
          if (desiredShortQty > existing.quantity) {
            // Increase hedge — add to short
            const addQty = desiredShortQty - existing.quantity;
            const newAvgEntry = (existing.entryPrice * existing.quantity + price * addQty) / desiredShortQty;
            existing.entryPrice = newAvgEntry;
            existing.quantity = desiredShortQty;
            existing.lastAdjustedAt = Date.now();
            console.error(chalk.magenta(
              `  [hedge] INCREASE ${fill.token} short to ${desiredShortQty.toFixed(6)} @ avg $${newAvgEntry.toFixed(2)}`
            ));
            adjustments++;
          } else {
            // Decrease hedge — partially close short
            const closeQty = existing.quantity - desiredShortQty;
            const closePnl = (existing.entryPrice - price) * closeQty;
            state.totalRealizedPnl += closePnl;
            state.todayRealizedPnl += closePnl;
            existing.realizedPnl += closePnl;
            existing.quantity = desiredShortQty;
            existing.lastAdjustedAt = Date.now();
            console.error(chalk.magenta(
              `  [hedge] DECREASE ${fill.token} short to ${desiredShortQty.toFixed(6)}, ` +
              `closed ${closeQty.toFixed(6)} PnL: $${closePnl.toFixed(2)}`
            ));
            adjustments++;
          }
        }

        // Compute unrealized PnL on current hedge
        const uPnl = (existing.entryPrice - price) * existing.quantity;
        unrealizedPnl += uPnl;
      } else {
        // Hedge was closed but fills are back — reopen
        existing.entryPrice = price;
        existing.quantity = desiredShortQty;
        existing.lastAdjustedAt = Date.now();
        console.error(chalk.magenta(
          `  [hedge] REOPEN ${fill.token} short ${desiredShortQty.toFixed(6)} @ $${price.toFixed(2)}`
        ));
        adjustments++;
      }
    }

    // Close hedges for tokens no longer in the fill list
    for (const pos of state.positions) {
      if (pos.quantity <= 0) continue;
      if (!openFills.find(f => f.token === pos.token)) {
        const price = prices[pos.token];
        if (price) {
          const closePnl = (pos.entryPrice - price) * pos.quantity;
          state.totalRealizedPnl += closePnl;
          state.todayRealizedPnl += closePnl;
          pos.realizedPnl += closePnl;
          console.error(chalk.yellow(
            `  [hedge] CLOSE orphaned ${pos.token} short, PnL: $${closePnl.toFixed(2)}`
          ));
          pos.quantity = 0;
          adjustments++;
        }
      }
    }

    await this.save();

    return {
      adjustments,
      unrealizedPnl,
      totalRealizedPnl: state.totalRealizedPnl,
    };
  }

  /** Get current hedge status for display. */
  getStatus(): { positions: HedgePosition[]; totalRealizedPnl: number; todayRealizedPnl: number } | null {
    if (!this.state) return null;
    return {
      positions: this.state.positions.filter(p => p.quantity > 0),
      totalRealizedPnl: this.state.totalRealizedPnl,
      todayRealizedPnl: this.state.todayRealizedPnl,
    };
  }
}
