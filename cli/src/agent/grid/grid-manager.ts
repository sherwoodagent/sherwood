/**
 * Grid Manager — core engine for ATR-based grid trading.
 *
 * Builds grid levels from ATR, simulates fills against real prices each tick,
 * handles paired-order replacement and periodic rebalancing.
 */

import chalk from 'chalk';
import type {
  GridConfig,
  GridLevel,
  GridFill,
  GridTokenState,
  GridPortfolioState,
} from './grid-config.js';
import { GridPortfolio } from './grid-portfolio.js';
import { HyperliquidProvider } from '../../providers/data/hyperliquid.js';
import { getLatestSignals } from '../technical.js';

export class GridManager {
  private config: GridConfig;
  private portfolio: GridPortfolio;
  private hl: HyperliquidProvider;

  constructor(config: GridConfig) {
    this.config = config;
    this.portfolio = new GridPortfolio();
    this.hl = new HyperliquidProvider();
  }

  /** Load or initialize grid state. Returns USD carved from directional portfolio (0 if already initialized). */
  async init(totalPortfolioValue: number): Promise<number> {
    const existing = await this.portfolio.load();
    if (existing) return 0;
    return this.portfolio.initialize(totalPortfolioValue, this.config);
  }

  /**
   * Run one grid tick — called every cycle from the agent loop.
   *
   * 1. Load state + reset daily counters
   * 2. For each token grid: fetch price, simulate fills, check rebalance
   * 3. Persist state
   *
   * Returns a summary for the cycle log.
   */
  async tick(prices: Record<string, number>): Promise<GridTickResult> {
    const state = await this.portfolio.load();
    if (!state || state.paused || !this.config.enabled) {
      return { fills: 0, roundTrips: 0, pnlUsd: 0, paused: state?.paused ?? false };
    }

    // Reset daily counters at UTC boundary
    this.portfolio.resetDailyStats(state);

    let totalFills = 0;
    let totalRoundTrips = 0;
    let totalPnl = 0;

    for (const grid of state.grids) {
      const price = prices[grid.token];
      if (!price || price <= 0) continue;

      // Build grid on first tick or after full rebuild interval
      if (grid.levels.length === 0 || this.needsFullRebuild(grid)) {
        await this.buildGrid(grid, price);
      }

      // Simulate fills
      const { fills, roundTrips, pnlUsd } = this.simulateFills(grid, price);
      totalFills += fills;
      totalRoundTrips += roundTrips;
      totalPnl += pnlUsd;

      // Check rebalance (shift grid if price drifted)
      if (this.needsShift(grid, price)) {
        await this.shiftGrid(grid, price);
      }
    }

    // Check pause threshold
    this.portfolio.checkPauseThreshold(state, this.config);

    // Persist
    await this.portfolio.save(state);

    return { fills: totalFills, roundTrips: totalRoundTrips, pnlUsd: totalPnl, paused: false };
  }

  /** Build a fresh grid centered on the current price using ATR. */
  private async buildGrid(grid: GridTokenState, currentPrice: number): Promise<void> {
    // Fetch ATR from HL candles
    const candles = await this.hl.getCandles(grid.token, '4h', 14 * 24 * 60 * 60 * 1000);
    if (!candles || candles.length < this.config.atrPeriod) {
      console.error(chalk.dim(`  [grid] Cannot build grid for ${grid.token}: insufficient candle data`));
      return;
    }

    const signals = getLatestSignals(candles);
    const atr = signals.atr;
    if (!Number.isFinite(atr) || atr <= 0) {
      console.error(chalk.dim(`  [grid] Cannot build grid for ${grid.token}: invalid ATR (${atr})`));
      return;
    }

    const range = atr * this.config.atrMultiplier;
    const spacing = range / this.config.levelsPerSide;
    const effectiveCapital = grid.allocation * this.config.leverage;
    const quantity = effectiveCapital / (this.config.levelsPerSide * currentPrice);

    const levels: GridLevel[] = [];

    // Buy levels below current price
    for (let i = 1; i <= this.config.levelsPerSide; i++) {
      levels.push({
        price: currentPrice - spacing * i,
        side: 'buy',
        quantity,
        filled: false,
        filledAt: 0,
      });
    }

    // Sell levels above current price
    for (let i = 1; i <= this.config.levelsPerSide; i++) {
      levels.push({
        price: currentPrice + spacing * i,
        side: 'sell',
        quantity,
        filled: false,
        filledAt: 0,
      });
    }

    grid.levels = levels;
    grid.centerPrice = currentPrice;
    grid.atr = atr;
    grid.stats.lastRebalanceAt = Date.now();

    console.error(chalk.dim(
      `  [grid] Built ${grid.token} grid: center=$${currentPrice.toFixed(2)} ` +
      `ATR=$${atr.toFixed(2)} range=$${(currentPrice - range).toFixed(2)}-$${(currentPrice + range).toFixed(2)} ` +
      `spacing=$${spacing.toFixed(2)} qty=${quantity.toFixed(6)}`
    ));
  }

  /** Simulate order fills against the current price. */
  private simulateFills(
    grid: GridTokenState,
    currentPrice: number,
  ): { fills: number; roundTrips: number; pnlUsd: number } {
    let fills = 0;
    let roundTrips = 0;
    let pnlUsd = 0;
    const now = Date.now();
    const spacing = grid.atr > 0
      ? (grid.atr * this.config.atrMultiplier) / this.config.levelsPerSide
      : 0;

    if (spacing <= 0) return { fills: 0, roundTrips: 0, pnlUsd: 0 };

    for (const level of grid.levels) {
      if (level.filled) continue;

      // Buy level fills when price drops to or below the level
      if (level.side === 'buy' && currentPrice <= level.price) {
        level.filled = true;
        level.filledAt = now;
        fills++;
        grid.stats.totalFills++;
        grid.stats.todayFills++;

        // Record open fill waiting for paired sell
        grid.openFills.push({
          token: grid.token,
          buyPrice: level.price,
          targetSellPrice: level.price + spacing,
          quantity: level.quantity,
          filledAt: now,
          closed: false,
          pnlUsd: 0,
          closedAt: 0,
        });

        console.error(chalk.dim(
          `  [grid] BUY fill ${grid.token} @ $${level.price.toFixed(2)} qty=${level.quantity.toFixed(6)}`
        ));
      }

      // Sell level fills when price rises to or above the level
      if (level.side === 'sell' && currentPrice >= level.price) {
        level.filled = true;
        level.filledAt = now;
        fills++;
        grid.stats.totalFills++;
        grid.stats.todayFills++;

        // Try to close the oldest open fill for this token
        const openFill = grid.openFills.find(f => !f.closed && f.token === grid.token);
        if (openFill) {
          const profit = (level.price - openFill.buyPrice) * openFill.quantity * this.config.leverage;
          if (profit >= this.config.minProfitPerFillUsd) {
            openFill.closed = true;
            openFill.pnlUsd = profit;
            openFill.closedAt = now;
            pnlUsd += profit;
            roundTrips++;
            grid.stats.totalRoundTrips++;
            grid.stats.totalPnlUsd += profit;
            grid.stats.todayPnlUsd += profit;
            grid.allocation += profit; // profits compound

            console.error(chalk.green(
              `  [grid] ROUND-TRIP ${grid.token}: buy $${openFill.buyPrice.toFixed(2)} → sell $${level.price.toFixed(2)} = +$${profit.toFixed(2)}`
            ));
          }
        }

        console.error(chalk.dim(
          `  [grid] SELL fill ${grid.token} @ $${level.price.toFixed(2)} qty=${level.quantity.toFixed(6)}`
        ));
      }
    }

    // Prune closed fills older than 24h to prevent unbounded growth
    const pruneThreshold = now - 24 * 60 * 60 * 1000;
    grid.openFills = grid.openFills.filter(f => !f.closed || f.closedAt > pruneThreshold);

    return { fills, roundTrips, pnlUsd };
  }

  /** Check if the grid needs a full rebuild. */
  private needsFullRebuild(grid: GridTokenState): boolean {
    if (grid.levels.length === 0) return true;
    const elapsed = Date.now() - grid.stats.lastRebalanceAt;
    return elapsed >= this.config.fullRebuildIntervalMs;
  }

  /** Check if price has drifted enough to warrant shifting the grid. */
  private needsShift(grid: GridTokenState, currentPrice: number): boolean {
    if (grid.centerPrice <= 0 || grid.atr <= 0) return false;
    const range = grid.atr * this.config.atrMultiplier;
    const distFromCenter = Math.abs(currentPrice - grid.centerPrice);
    return distFromCenter / range >= this.config.rebalanceDriftPct;
  }

  /** Shift the grid to re-center on the current price. */
  private async shiftGrid(grid: GridTokenState, currentPrice: number): Promise<void> {
    console.error(chalk.dim(
      `  [grid] Shifting ${grid.token} grid: center $${grid.centerPrice.toFixed(2)} → $${currentPrice.toFixed(2)}`
    ));
    // Full rebuild with the new center — keeps existing open fills
    await this.buildGrid(grid, currentPrice);
  }

  /** Get aggregate stats for display. */
  getStats(): { totalPnlUsd: number; todayPnlUsd: number; todayFills: number; totalRoundTrips: number; allocation: number; paused: boolean } | null {
    const state = this.portfolio.getState();
    if (!state) return null;
    const agg = this.portfolio.aggregateStats(state);
    return {
      ...agg,
      allocation: state.totalAllocation,
      paused: state.paused,
    };
  }
}

export interface GridTickResult {
  fills: number;
  roundTrips: number;
  pnlUsd: number;
  paused: boolean;
}
