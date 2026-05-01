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
} from './config.js';
import { GridPortfolio } from './portfolio.js';
import { HyperliquidProvider } from '../providers/data/hyperliquid.js';
import { getLatestSignals } from '../agent/technical.js';

/** Decides if a level should fire at the current price.
 *  Default checks against close; backtest checks against bar.low/high. */
export type FillDetector = (level: GridLevel, currentPrice: number) => boolean;

/** Decides if an open fill's target has been reached.
 *  Default checks against close; backtest checks against bar.high. */
export type CloseFillDetector = (openFill: GridFill, currentPrice: number) => boolean;

/** Fetches OHLCV candles for ATR. Default delegates to HyperliquidProvider. */
export type CandleFetcher = (
  tokenId: string,
  interval: '1h' | '4h' | '1d',
  lookbackMs: number,
) => Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null>;

const defaultFillDetector: FillDetector = (level, currentPrice) =>
  level.side === 'buy' ? currentPrice <= level.price : currentPrice >= level.price;

const defaultCloseFillDetector: CloseFillDetector = (openFill, currentPrice) =>
  currentPrice >= openFill.targetSellPrice;

export class GridManager {
  private config: GridConfig;
  private portfolio: GridPortfolio;
  private hl: HyperliquidProvider;
  private candleFetcher: CandleFetcher;
  private fillDetector: FillDetector;
  private closeFillDetector: CloseFillDetector;
  private nowProvider: () => number;

  constructor(
    config: GridConfig,
    candleFetcher?: CandleFetcher,
    fillDetector?: FillDetector,
    closeFillDetector?: CloseFillDetector,
    portfolio?: GridPortfolio,
    nowProvider?: () => number,
  ) {
    this.config = config;
    this.portfolio = portfolio ?? new GridPortfolio();
    this.hl = new HyperliquidProvider();
    this.candleFetcher = candleFetcher ?? ((tokenId, interval, lookbackMs) =>
      this.hl.getCandles(tokenId, interval, lookbackMs));
    this.fillDetector = fillDetector ?? defaultFillDetector;
    this.closeFillDetector = closeFillDetector ?? defaultCloseFillDetector;
    this.nowProvider = nowProvider ?? (() => Date.now());
  }

  /** Load or initialize grid state.
   *  Also syncs new tokens added to config after initial grid setup. */
  async init(totalPortfolioValue: number): Promise<void> {
    const existing = await this.portfolio.load();
    if (!existing) {
      await this.portfolio.initialize(totalPortfolioValue, this.config);
      return;
    }

    // Sync: add grids for tokens in config but not yet in state
    let addedAllocation = 0;
    for (const token of this.config.tokens) {
      if (!existing.grids.find(g => g.token === token)) {
        const split = this.config.tokenSplit[token] ?? (1 / this.config.tokens.length);
        const alloc = existing.totalAllocation * split;
        existing.grids.push({
          token,
          levels: [],
          openFills: [],
          allocation: alloc,
          stats: { totalRoundTrips: 0, totalPnlUsd: 0, todayPnlUsd: 0, totalFills: 0, todayFills: 0, lastDailyReset: 0, lastRebalanceAt: 0 },
          centerPrice: 0,
          atr: 0,
          trend: 0,
          lastTrendRefreshAt: 0,
        });
        addedAllocation += alloc;
        console.error(`  [grid] Added new token grid: ${token} ($${alloc.toFixed(0)} allocation)`);
      }
    }
    if (addedAllocation > 0) {
      await this.portfolio.save(existing);
    }
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
  async tick(prices: Record<string, number>, regime?: string): Promise<GridTickResult> {
    const state = await this.portfolio.load();
    if (!state || !this.config.enabled) {
      return { fills: 0, roundTrips: 0, pnlUsd: 0, paused: false };
    }

    // When paused, still run the pause/resume check — drawdown may have
    // recovered and the grid should auto-resume via unpauseRecoveryPct.
    if (state.paused) {
      const resumed = this.portfolio.checkPauseThreshold(state, this.config, prices);
      if (resumed) {
        await this.portfolio.save(state);
      }
      return { fills: 0, roundTrips: 0, pnlUsd: 0, paused: state.paused };
    }

    // Regime-aware grid control: only pause in high-volatility (dangerous swings).
    // Previously also paused buys in trending regimes, but the global regime
    // detector lags — BTC can be ranging $76-78k for a day while EMA(21,50)
    // still says "trending-up". The grid's own rebalance drift check is a
    // better signal: if price hasn't triggered a rebalance, it's range-bound
    // within the grid regardless of what the macro regime says.
    if (regime === 'high-volatility') {
      console.error(chalk.dim(`  [grid] Paused: high-volatility regime — too risky for grid`));
      return { fills: 0, roundTrips: 0, pnlUsd: 0, paused: false };
    }

    // Reset daily counters at UTC boundary
    this.portfolio.resetDailyStats(state);

    let totalFills = 0;
    let totalRoundTrips = 0;
    let totalPnl = 0;

    for (const grid of state.grids) {
      const price = prices[grid.token];
      if (!price || price <= 0) continue;

      // Refresh trend at most once per hour. Lets the downtrend filter
      // respond to fast crashes between scheduled rebuilds (12h cadence).
      // No-op when buildGrid runs this same tick — it overwrites trend anyway.
      await this.maybeRefreshTrend(grid);

      // Build grid on first tick or after full rebuild interval
      if (grid.levels.length === 0 || this.needsFullRebuild(grid)) {
        await this.buildGrid(grid, price);
      }

      // Simulate fills — both buys and sells. The grid's own rebalance drift
      // handles directional moves (rebuilds when price drifts 40% toward edge).
      const { fills, roundTrips, pnlUsd } = this.simulateFills(grid, price);
      totalFills += fills;
      totalRoundTrips += roundTrips;
      totalPnl += pnlUsd;

      // Check rebalance (shift grid if price drifted)
      if (this.needsShift(grid, price)) {
        await this.shiftGrid(grid, price);
      }
    }

    // Check pause threshold (uses current prices for mark-to-market)
    this.portfolio.checkPauseThreshold(state, this.config, prices);

    // Persist
    await this.portfolio.save(state);

    return { fills: totalFills, roundTrips: totalRoundTrips, pnlUsd: totalPnl, paused: false };
  }

  /** Hourly refresh of `grid.trend` from recent 4h candles. Called from
   *  tick() so the downtrend filter sees fresh data between buildGrid runs. */
  private async maybeRefreshTrend(grid: GridTokenState): Promise<void> {
    const now = this.nowProvider();
    const ONE_HOUR = 60 * 60 * 1000;
    if (now - grid.lastTrendRefreshAt < ONE_HOUR) return;

    // 14 4h bars = 56h lookback (matches buildGrid window).
    const candles = await this.candleFetcher(grid.token, '4h', 14 * 4 * 60 * 60 * 1000);
    if (!candles || candles.length < 2) return;

    const TREND_LOOKBACK_BARS = 14;
    const sliceStart = Math.max(0, candles.length - TREND_LOOKBACK_BARS);
    const first = candles[sliceStart]!.close;
    const last = candles[candles.length - 1]!.close;
    if (first <= 0) return;

    grid.trend = (last - first) / first;
    grid.lastTrendRefreshAt = now;
  }

  /** Build a fresh grid centered on the current price using ATR. */
  private async buildGrid(grid: GridTokenState, currentPrice: number): Promise<void> {
    // Fetch ATR from HL candles
    const candles = await this.candleFetcher(grid.token, '4h', 14 * 24 * 60 * 60 * 1000);
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

    // Trend signal: % change over the last 14 4h bars (~56 hours).
    // Using only the recent window so the trend captures local direction,
    // not all-time-vs-now (which would always be ~0 over multi-month
    // backtests where price ends near where it started).
    const TREND_LOOKBACK_BARS = 14;
    let trend = 0;
    if (candles.length >= 2) {
      const sliceStart = Math.max(0, candles.length - TREND_LOOKBACK_BARS);
      const first = candles[sliceStart]!.close;
      const last = candles[candles.length - 1]!.close;
      if (first > 0) {
        trend = (last - first) / first;
      }
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
    grid.trend = trend;
    grid.stats.lastRebalanceAt = Date.now();

    console.error(chalk.dim(
      `  [grid] Built ${grid.token} grid: center=$${currentPrice.toFixed(2)} ` +
      `ATR=$${atr.toFixed(2)} range=$${(currentPrice - range).toFixed(2)}-$${(currentPrice + range).toFixed(2)} ` +
      `spacing=$${spacing.toFixed(2)} qty=${quantity.toFixed(6)} trend=${(trend * 100).toFixed(1)}%`
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

    // Max-exposure cap: stop placing new BUY fills when total open notional
    // exceeds the configured multiple of effective capital. Existing fills
    // can still close (sell levels and close-outs unaffected). Set
    // `maxOpenNotionalMultiple = Infinity` to disable.
    // Cap measures ENTRY notional (qty × buyPrice), not mark-to-market.
    // Mark-to-market shrinks as price falls, which would loosen the cap
    // exactly when we need it to bite (downtrends accumulating buys).
    const exposureCap = grid.allocation * this.config.leverage * this.config.maxOpenNotionalMultiple;
    const currentOpenNotional = grid.openFills
      .filter(f => !f.closed)
      .reduce((s, f) => s + f.quantity * f.buyPrice, 0);
    const buyExposureFull = currentOpenNotional >= exposureCap;

    // Downtrend filter: block new buy fills if the grid was built during a
    // sustained drop (trend < -downtrendBlockPct). Re-evaluated each rebuild
    // so buys resume when trend recovers. Set downtrendBlockPct=0 to disable.
    const inDowntrend = this.config.downtrendBlockPct > 0 && grid.trend < -this.config.downtrendBlockPct;

    // Step 1: Fill unfilled grid levels (buy when price drops, sell is just accounting)
    for (const level of grid.levels) {
      if (level.filled) continue;

      if (level.side === 'buy' && this.fillDetector(level, currentPrice)) {
        if (buyExposureFull) {
          continue;  // skip — would exceed max open exposure
        }
        if (inDowntrend) {
          continue;  // skip — sustained downtrend, don't buy into the knife
        }
        level.filled = true;
        level.filledAt = now;
        fills++;
        grid.stats.totalFills++;
        grid.stats.todayFills++;

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

      if (level.side === 'sell' && this.fillDetector(level, currentPrice)) {
        level.filled = true;
        level.filledAt = now;
        fills++;
        grid.stats.totalFills++;
        grid.stats.todayFills++;

        console.error(chalk.dim(
          `  [grid] SELL level ${grid.token} @ $${level.price.toFixed(2)} qty=${level.quantity.toFixed(6)}`
        ));
      }
    }

    // Step 2: Close open fills whose targetSellPrice has been reached.
    // This is decoupled from level fills — an open fill closes when
    // currentPrice >= its specific target, regardless of grid levels.
    // Bug fix: previously this only ran inside the sell-level loop, so
    // once a sell level was marked filled it was skipped on future ticks,
    // orphaning any open fill that wasn't matched at that exact moment.
    for (const openFill of grid.openFills) {
      if (openFill.closed) continue;
      if (this.closeFillDetector(openFill, currentPrice)) {
        // PnL = price_change × quantity. quantity is already the leveraged
        // contract size (effectiveCapital / (levels × price) at build), so
        // multiplying by leverage again would double-count. The realized
        // dollar PnL here is the same as a real futures position would book.
        const profit = (currentPrice - openFill.buyPrice) * openFill.quantity;
        if (profit >= this.config.minProfitPerFillUsd) {
          openFill.closed = true;
          openFill.pnlUsd = profit;
          openFill.closedAt = now;
          pnlUsd += profit;
          roundTrips++;
          grid.stats.totalRoundTrips++;
          grid.stats.totalPnlUsd += profit;
          grid.stats.todayPnlUsd += profit;
          grid.allocation += profit;

          console.error(chalk.green(
            `  [grid] ROUND-TRIP ${grid.token}: buy $${openFill.buyPrice.toFixed(2)} → sell $${currentPrice.toFixed(2)} = +$${profit.toFixed(2)}`
          ));
        }
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

  /** Get open fill exposure per token — used by the hedge manager. */
  getOpenFillExposure(): Array<{ token: string; totalQuantity: number; totalNotional: number; avgEntryPrice: number; fillCount: number }> {
    const state = this.portfolio.getState();
    if (!state) return [];
    return state.grids.map(g => {
      const opens = g.openFills.filter(f => !f.closed);
      const totalQty = opens.reduce((s, f) => s + f.quantity, 0);
      const totalNotional = opens.reduce((s, f) => s + f.quantity * f.buyPrice, 0);
      return {
        token: g.token,
        totalQuantity: totalQty,
        totalNotional,
        avgEntryPrice: totalQty > 0 ? totalNotional / totalQty : 0,
        fillCount: opens.length,
      };
    }).filter(e => e.fillCount > 0);
  }

  /**
   * Compute the orders that should be placed for the current grid state,
   * without simulating fills. Used by the live executor.
   *
   * Returns:
   *   - ordersToPlace: all current grid levels that haven't been filled
   *   - assetsToCancel: tokens whose grid was rebalanced (need cancel-and-place)
   *   - needsRebalance: whether any grid was rebuilt this tick
   */
  computeOrders(prices: Record<string, number>): GridOrderPlan {
    const state = this.portfolio.getState();
    if (!state || state.paused || !this.config.enabled) {
      return { ordersToPlace: [], assetsToCancel: [], needsRebalance: false };
    }

    const ordersToPlace: ComputedOrder[] = [];
    const assetsToCancel: string[] = [];
    let needsRebalance = false;

    for (const grid of state.grids) {
      const price = prices[grid.token];
      if (!price || price <= 0) continue;

      const wasEmpty = grid.levels.length === 0;
      const fullRebuild = wasEmpty || this.needsFullRebuild(grid);
      const shift = !fullRebuild && grid.centerPrice > 0 && this.needsShift(grid, price);

      if (fullRebuild || shift) {
        needsRebalance = true;
        if (!wasEmpty) assetsToCancel.push(grid.token);
      }

      for (const level of grid.levels) {
        if (level.filled) continue;
        ordersToPlace.push({
          token: grid.token,
          isBuy: level.side === 'buy',
          price: level.price,
          quantity: level.quantity,
        });
      }
    }

    return { ordersToPlace, assetsToCancel, needsRebalance };
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

export interface ComputedOrder {
  token: string;
  isBuy: boolean;
  price: number;
  quantity: number;
}

export interface GridOrderPlan {
  ordersToPlace: ComputedOrder[];
  assetsToCancel: string[];
  needsRebalance: boolean;
}
