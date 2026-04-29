/**
 * Grid trading strategy — types and configuration.
 *
 * ATR-based grid that profits from ranging-market volatility on BTC + ETH.
 * Runs as a parallel mode alongside the directional signal-based strategy
 * with isolated capital allocation.
 */

// ── Types ──

export interface GridLevel {
  /** Price at which this order fills. */
  price: number;
  /** 'buy' below current price, 'sell' above. */
  side: 'buy' | 'sell';
  /** Quantity per fill (in token units, e.g. 0.0124 BTC). */
  quantity: number;
  /** True if this level has been filled and is waiting for its paired order. */
  filled: boolean;
  /** Timestamp of fill (0 if unfilled). */
  filledAt: number;
}

export interface GridFill {
  /** Token ID (e.g. 'bitcoin'). */
  token: string;
  /** Price at which we bought. */
  buyPrice: number;
  /** Price at which the paired sell should execute. */
  targetSellPrice: number;
  /** Quantity in token units. */
  quantity: number;
  /** Timestamp of buy fill. */
  filledAt: number;
  /** If this fill has been closed by its paired sell. */
  closed: boolean;
  /** PnL when closed (before leverage). */
  pnlUsd: number;
  /** Timestamp of close. */
  closedAt: number;
}

export interface GridStats {
  /** Completed buy→sell round-trips. */
  totalRoundTrips: number;
  /** Cumulative grid profit in USD (after leverage). */
  totalPnlUsd: number;
  /** Today's grid profit (resets UTC midnight). */
  todayPnlUsd: number;
  /** Total fills (buy + sell) since inception. */
  totalFills: number;
  /** Today's fills. */
  todayFills: number;
  /** Last daily reset timestamp. */
  lastDailyReset: number;
  /** Last full grid rebuild timestamp. */
  lastRebalanceAt: number;
}

export interface GridTokenState {
  /** CoinGecko token ID. */
  token: string;
  /** Current active grid levels. */
  levels: GridLevel[];
  /** Open fills waiting for their paired sell/buy. */
  openFills: GridFill[];
  /** USD allocated to this token's grid. */
  allocation: number;
  /** Cumulative stats for this token's grid. */
  stats: GridStats;
  /** Price at center when grid was last built/rebalanced. */
  centerPrice: number;
  /** ATR at last build. */
  atr: number;
}

export interface GridPortfolioState {
  /** Total USD carved out for the grid strategy. */
  totalAllocation: number;
  /** Per-token grid state. */
  grids: GridTokenState[];
  /** Whether grid is paused (pool dropped below threshold). */
  paused: boolean;
  /** Reason for pause (empty if active). */
  pauseReason: string;
  /** Timestamp of initial allocation. */
  initializedAt: number;
}

// ── Configuration ──

export interface GridConfig {
  /** Enable/disable the grid strategy. */
  enabled: boolean;
  /** Tokens to run grids on. */
  tokens: string[];
  /** Fraction of total portfolio to allocate to grid (0.35 = 35%). */
  allocationPct: number;
  /** Leverage multiplier on grid capital. */
  leverage: number;
  /** Number of buy levels below price (same number of sell levels above). */
  levelsPerSide: number;
  /** Grid range = price ± (atrMultiplier × ATR). */
  atrMultiplier: number;
  /** ATR lookback period. */
  atrPeriod: number;
  /** Shift grid when price drifts past this fraction of the range toward one edge. */
  rebalanceDriftPct: number;
  /** Full grid rebuild interval in ms. */
  fullRebuildIntervalMs: number;
  /** Per-token allocation split (must sum to 1.0). */
  tokenSplit: Record<string, number>;
  /** Skip fills where profit per round-trip < this (fee floor). */
  minProfitPerFillUsd: number;
  /** Pause grid if pool drops this fraction from initial allocation. */
  pauseThresholdPct: number;
}

export const DEFAULT_GRID_CONFIG: GridConfig = {
  enabled: true,
  tokens: ['bitcoin', 'ethereum', 'solana'],
  allocationPct: 0.50,
  leverage: 5,                                  // was 4 — +25% profit per RT
  levelsPerSide: 15,
  atrMultiplier: 2,
  atrPeriod: 14,
  rebalanceDriftPct: 0.40,                      // was 0.55 — rebalance faster, keep levels near price
  fullRebuildIntervalMs: 12 * 60 * 60 * 1000,   // 12h
  tokenSplit: { bitcoin: 0.45, ethereum: 0.30, solana: 0.25 },
  minProfitPerFillUsd: 0.50,
  pauseThresholdPct: 0.20,
};
