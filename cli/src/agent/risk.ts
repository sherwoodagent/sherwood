/**
 * Risk management module — position sizing, drawdown limits, stop-loss management.
 */

import chalk from 'chalk';
import type { UncertaintyMetrics } from './calibration-live.js';

export interface PortfolioState {
  totalValue: number;
  positions: Position[];
  cash: number;
  dailyPnl: number;
  weeklyPnl: number;
  monthlyPnl: number;
  lastDailyReset?: number;
  lastWeeklyReset?: number;
  lastMonthlyReset?: number;
  /** Token → timestamp of last stop-loss exit. Used to enforce cooldown
   *  before re-entry to prevent the stop-reentry-stop pattern. */
  stopCooldowns?: Record<string, number>;
  /** Orca-inspired: PnL-aware daily cap, see README / PR #223.
   *  Count of NEW position entries (not pyramid adds) opened since the
   *  last daily reset. Used together with getDynamicDailyCap() to throttle
   *  entry frequency based on the day's realized PnL. */
  dailyEntries?: number;
  /** Timestamp of the last `dailyEntries` reset — tracked independently
   *  from `lastDailyReset` so future boundary logic can diverge if needed
   *  (and so legacy portfolio.json files without this field reset cleanly). */
  lastDailyEntriesReset?: number;
  /** Portfolio value at inception — used to compute cumulative PnL%.
   *  Defaults to the DEFAULT_PORTFOLIO value ($10k) for legacy files, or
   *  the on-chain vault balance for live syndicates initialized via
   *  `initFromOnChain`. Never updated after the first load. */
  initialValue?: number;
}

export interface Position {
  tokenId: string;
  symbol: string;
  /** 'long' (default for backward compat) or 'short'. */
  side?: 'long' | 'short';
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  entryTimestamp: number;
  stopLoss: number;
  takeProfit: number;
  trailingStop?: number;
  strategy: string;
  pnlPercent: number;
  pnlUsd: number;
  /** Number of pyramid adds since initial entry (0 = base position).
   *  Capped by RiskManager.canOpenPosition; each add halves the prior add size. */
  addCount?: number;
  /** Timestamp of the most recent add (or initial entry).
   *  Used to enforce minimum spacing between adds. */
  lastAddTimestamp?: number;
  /** ATR-14 at the time of entry. Used for per-position trailing stop
   *  distance (1.0×ATR) and breakeven trigger calibration. */
  atrAtEntry?: number;
  /** Whether the 50% partial-profit exit has been taken. Prevents
   *  re-triggering on subsequent cycles. */
  partialTaken?: boolean;
  /** Orca-inspired: HWM-based profit-lock, see README / PR #223.
   *  For LONG: the highest price seen since entry (>= entryPrice).
   *  For SHORT: the lowest price seen since entry (<= entryPrice).
   *  Updated each cycle in `updateTrailingStops`. Enables stop-loss
   *  ratcheting based on peak-to-date gain rather than unrealized PnL
   *  alone — so a retrace followed by a new peak always advances the
   *  lock, never resets it. Persisted to portfolio.json. Legacy positions
   *  loaded without this field default to entryPrice (safest — never
   *  locks too aggressively on the first cycle post-upgrade). */
  peakPrice?: number;
}

export interface RiskConfig {
  maxPortfolioRisk: number;
  maxSinglePosition: number;
  maxCorrelatedExposure: number;
  maxConcurrentTrades: number;
  hardStopPercent: number;
  trailingStopAtr: number;
  /** Trailing stop as a fraction of current price (e.g. 0.05 = stop at price × 0.95).
   *  Used by updateTrailingStops() which runs each loop cycle without needing ATR.
   *  Set to 0 to disable. */
  trailingStopPct: number;
  /** Move stop to entry (breakeven) once position gains this percent.
   *  E.g. 0.02 = after +2% unrealized gain, stop tightens to entry price.
   *  Set to 0 to disable. */
  breakevenTriggerPct: number;
  /** Orca-inspired HWM profit-lock, see README / PR #223.
   *  Stepped table: each {trigger, lockPct} pair means "once PnL% from
   *  entry crosses `trigger`, ratchet stop-loss to lock in `lockPct` of
   *  the peak move from entry".
   *  For LONG: stop = entry + (peakPrice - entry) * lockPct.
   *  For SHORT: stop = entry - (entry - peakPrice) * lockPct.
   *  Entries iterate in order; highest-triggered tier wins (stricter
   *  locks override looser ones) and stops only ratchet up — never down. */
  profitLockSteps: Array<{ trigger: number; lockPct: number }>;
  dailyLossLimit: number;
  weeklyLossLimit: number;
  monthlyLossLimit: number;
  maxSlippage: Record<string, number>;
  riskPerTrade: number;
  /** Orca-inspired: PnL-aware daily cap, see README / PR #223.
   *  When set, short-circuits the tiered step function in
   *  `getDynamicDailyCap()` and uses this value directly. Useful for
   *  tests or an aggressive-mode config override. Leave unset for the
   *  default PnL-tiered behavior. */
  dailyCapOverride?: number;
}

/**
 * Default risk config.
 *
 * `trailingStopPct` / `breakevenTriggerPct` / `profitLockSteps` are now ON
 * by default based on paper-trading analysis showing active trailing
 * significantly improves risk-adjusted returns. These match
 * RECOMMENDED_TRAILING_CONFIG (minus the third profit-lock step).
 *
 * Override via config:
 *   sherwood agent config --set trailingStopPct=0
 *   sherwood agent config --set breakevenTriggerPct=0
 */
export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxPortfolioRisk: 0.15,
  maxSinglePosition: 0.20,
  maxCorrelatedExposure: 0.20,
  maxConcurrentTrades: 5,
  hardStopPercent: 0.05,          // 5% hard stop — short-term trades shouldn't bleed past this
  trailingStopAtr: 1.5,
  trailingStopPct: 0.025,              // 2.5% fallback trail (overridden per-position by ATR when available)
  breakevenTriggerPct: 0.015,          // move to breakeven after +1.5% gain
  // Orca-inspired HWM profit-lock (see README / PR #223): each entry locks a
  // percentage of the peak-to-date move. Tiers cascade — the highest
  // triggered tier wins — and stops never ratchet down.
  profitLockSteps: [
    { trigger: 0.05, lockPct: 0.30 },  // +5% gain  → lock 30% of peak move
    { trigger: 0.10, lockPct: 0.50 },  // +10% gain → lock 50% of peak move
    { trigger: 0.15, lockPct: 0.70 },  // +15% gain → lock 70% of peak move
    { trigger: 0.20, lockPct: 0.85 },  // +20% gain → lock 85% of peak move
  ],
  dailyLossLimit: 0.05,
  weeklyLossLimit: 0.10,
  monthlyLossLimit: 0.15,
  maxSlippage: { large: 0.005, mid: 0.015, small: 0.03 },
  riskPerTrade: 0.02,
};

/**
 * Opinionated trailing-stop preset.
 *
 * To enable all three mechanisms at once:
 *   sherwood agent config --set trailingStopPct=0.05
 *   sherwood agent config --set breakevenTriggerPct=0.02
 *   (profitLockSteps currently requires editing config.json directly)
 */
/**
 * Short-term trailing config (1-2 day holds).
 * Tighter stops and faster profit-locking than swing trading.
 */
export const RECOMMENDED_TRAILING_CONFIG = {
  trailingStopPct: 0.025,                // 2.5% trail — tighter for short-term
  breakevenTriggerPct: 0.015,            // move to breakeven after +1.5% gain
  // HWM tiers: lock a growing fraction of the peak move from entry.
  profitLockSteps: [
    { trigger: 0.05, lockPct: 0.30 },   // +5% gain  → lock 30% of peak move
    { trigger: 0.10, lockPct: 0.50 },   // +10% gain → lock 50% of peak move
    { trigger: 0.15, lockPct: 0.70 },   // +15% gain → lock 70% of peak move
    { trigger: 0.20, lockPct: 0.85 },   // +20% gain → lock 85% of peak move
  ],
} as const;

/** Pyramiding configuration — conservative defaults to limit blowup risk
 *  on a single name. With MAX_PYRAMID_ADDS=2 and halving size each add,
 *  total exposure caps at 1.0x + 0.5x + 0.25x = 1.75x of the base size. */
export const MAX_PYRAMID_ADDS = 2;
export const PYRAMID_MIN_SPACING_MS = 4 * 60 * 60 * 1000; // 4 hours
export const STOP_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours after a stop-loss

const EMPTY_PORTFOLIO: PortfolioState = {
  totalValue: 0,
  positions: [],
  cash: 0,
  dailyPnl: 0,
  weeklyPnl: 0,
  monthlyPnl: 0,
};

export class RiskManager {
  private config: RiskConfig;
  private portfolio: PortfolioState;

  constructor(config?: Partial<RiskConfig>) {
    this.config = { ...DEFAULT_RISK_CONFIG, ...config };
    this.portfolio = { ...EMPTY_PORTFOLIO };
  }

  /** Base risk-per-trade fraction (e.g. 0.02 = 2%). Exposed so callers can
   *  apply conviction / profile multipliers without duplicating the config. */
  getRiskPerTrade(): number {
    return this.config.riskPerTrade;
  }

  /**
   * Orca-inspired PnL-aware daily cap (see README / PR #223).
   *
   * Returns the maximum number of NEW position entries allowed today based
   * on realized daily PnL as a fraction of the start-of-day portfolio
   * value. Tiers (step function):
   *
   *   >= +5%       → 12 ("hot hand")
   *   [ 0%, +5%)   →  8
   *   [-5%,  0%)   →  5
   *   [-15%, -5%)  →  3
   *   [-25%,-15%)  →  1
   *   < -25%       →  0 (circuit breaker)
   *
   * `config.dailyCapOverride` short-circuits to a fixed value when set
   * (tests / aggressive mode). The start-of-day value is reconstructed
   * as `totalValue - dailyPnl` — same trick loop.ts uses to derive
   * dailyPnlPct for the judge.
   *
   * Orthogonal to `maxConcurrentTrades`: that limits simultaneous open
   * positions; this limits turnover per day.
   */
  getDynamicDailyCap(): number {
    // Override short-circuit
    if (
      this.config.dailyCapOverride !== undefined
      && Number.isFinite(this.config.dailyCapOverride)
    ) {
      return Math.max(0, Math.floor(this.config.dailyCapOverride));
    }

    const totalValue = Number.isFinite(this.portfolio.totalValue) ? this.portfolio.totalValue : 0;
    const dailyPnl = Number.isFinite(this.portfolio.dailyPnl) ? this.portfolio.dailyPnl : 0;
    // Reconstruct start-of-day value (mirrors loop.ts:691 logic). Fall
    // back to cash when totalValue is unset to avoid a false 0% baseline.
    const startOfDayValue = (totalValue - dailyPnl) > 0
      ? totalValue - dailyPnl
      : (Number.isFinite(this.portfolio.cash) ? this.portfolio.cash : 0);

    if (startOfDayValue <= 0) {
      // No baseline to measure against — fall back to the middle tier.
      return 5;
    }

    const pnlPct = dailyPnl / startOfDayValue;

    if (pnlPct >= 0.05) return 12;
    if (pnlPct >= 0) return 8;
    if (pnlPct >= -0.05) return 5;
    if (pnlPct >= -0.15) return 3;
    if (pnlPct >= -0.25) return 1;
    return 0; // circuit breaker — no new entries today
  }

  /** Check if we can open a new position (or pyramid into an existing one).
   *  When `direction` is omitted, defaults to 'long' for backward compatibility.
   *  An existing position with a different direction always rejects (no flips
   *  via pyramid — flips must explicitly close the prior position first). */
  canOpenPosition(token: string, sizeUsd: number, direction: 'long' | 'short' = 'long'): { allowed: boolean; reason?: string } {
    // Check concurrent trades limit
    if (this.portfolio.positions.length >= this.config.maxConcurrentTrades) {
      return { allowed: false, reason: `Max concurrent trades (${this.config.maxConcurrentTrades}) reached` };
    }

    // Orca-inspired: PnL-aware daily entry cap (see README / PR #223).
    // Only applies to NEW positions — pyramid adds into an existing token
    // go through their own spacing / addCount guards below and do not
    // count toward the daily turnover budget.
    const isNewEntry = !this.portfolio.positions.find((p) => p.tokenId === token);
    if (isNewEntry) {
      const dailyCap = this.getDynamicDailyCap();
      const entriesToday = Number.isFinite(this.portfolio.dailyEntries)
        ? (this.portfolio.dailyEntries ?? 0)
        : 0;
      if (entriesToday >= dailyCap) {
        const totalValue = Number.isFinite(this.portfolio.totalValue) ? this.portfolio.totalValue : 0;
        const dailyPnl = Number.isFinite(this.portfolio.dailyPnl) ? this.portfolio.dailyPnl : 0;
        const startOfDayValue = (totalValue - dailyPnl) > 0 ? totalValue - dailyPnl : 0;
        const pnlPct = startOfDayValue > 0 ? (dailyPnl / startOfDayValue) * 100 : 0;
        return {
          allowed: false,
          reason: `Dynamic daily cap (${dailyCap}) reached — PnL ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`,
        };
      }
    }

    // Check single position size limit
    const portfolioValue = this.portfolio.totalValue || this.portfolio.cash;
    if (portfolioValue > 0) {
      const positionPct = sizeUsd / portfolioValue;
      if (positionPct > this.config.maxSinglePosition) {
        return {
          allowed: false,
          reason: `Position size ${(positionPct * 100).toFixed(1)}% exceeds max ${(this.config.maxSinglePosition * 100).toFixed(0)}% per trade`,
        };
      }
    }

    // Check total portfolio risk by evaluating potential aggregate loss
    if (portfolioValue > 0) {
      const currentRiskExposure = this.portfolio.positions.reduce(
        (sum, p) => {
          // Estimate max loss per position using stop loss distance
          const maxLossPerPosition = Math.abs(p.entryPrice - p.stopLoss) * p.quantity;
          return sum + maxLossPerPosition;
        },
        0,
      );

      // Estimate new position risk (assuming 8% stop loss)
      const newPositionRisk = sizeUsd * 0.08;
      const totalRiskExposure = currentRiskExposure + newPositionRisk;

      if (totalRiskExposure / portfolioValue > this.config.maxPortfolioRisk) {
        return {
          allowed: false,
          reason: `Total portfolio risk ${(totalRiskExposure / portfolioValue * 100).toFixed(1)}% would exceed max ${(this.config.maxPortfolioRisk * 100).toFixed(0)}%`,
        };
      }
    }

    // Check post-stop cooldown — prevent rapid re-entry after a stop loss
    const cooldowns = this.portfolio.stopCooldowns ?? {};
    const lastStop = cooldowns[token];
    if (lastStop !== undefined) {
      const elapsed = Date.now() - lastStop;
      if (elapsed < STOP_COOLDOWN_MS) {
        const remainHrs = ((STOP_COOLDOWN_MS - elapsed) / 3_600_000).toFixed(1);
        return { allowed: false, reason: `Stop cooldown active for ${token} (${remainHrs}h remaining)` };
      }
    }

    // Check if we already have a position in this token.
    // Pyramiding (adding to a winning position) is allowed up to MAX_PYRAMID_ADDS
    // total adds, with at least PYRAMID_MIN_SPACING_MS between adds. The caller
    // (TradeExecutor) is responsible for halving the size each add and matching
    // the existing direction. If those preconditions aren't met, the executor
    // should not call canOpenPosition for an add.
    const existing = this.portfolio.positions.find((p) => p.tokenId === token);
    if (existing) {
      const existingSide = existing.side ?? 'long';
      if (existingSide !== direction) {
        return { allowed: false, reason: `Conflicting position in ${token} (existing ${existingSide}, signal ${direction}) — close first` };
      }
      const addCount = existing.addCount ?? 0;
      if (addCount >= MAX_PYRAMID_ADDS) {
        return { allowed: false, reason: `Pyramid cap reached for ${token} (${MAX_PYRAMID_ADDS} adds)` };
      }
      const lastAdd = existing.lastAddTimestamp ?? existing.entryTimestamp;
      const elapsed = Date.now() - lastAdd;
      if (elapsed < PYRAMID_MIN_SPACING_MS) {
        const remainHrs = ((PYRAMID_MIN_SPACING_MS - elapsed) / 3_600_000).toFixed(1);
        return { allowed: false, reason: `Pyramid spacing not met for ${token} (next add in ${remainHrs}h)` };
      }
    }

    // Check cash availability
    if (sizeUsd > this.portfolio.cash) {
      return { allowed: false, reason: `Insufficient cash: need $${sizeUsd.toFixed(2)}, have $${this.portfolio.cash.toFixed(2)}` };
    }

    // Check drawdown limits
    const drawdown = this.isDrawdownLimitHit();
    if (drawdown.paused) {
      return { allowed: false, reason: drawdown.message };
    }

    // Check correlated exposure by token category
    const TOKEN_CATEGORIES: Record<string, string> = {
      bitcoin: 'L1', ethereum: 'L1', solana: 'L1', avalanche: 'L1', cardano: 'L1',
      polkadot: 'L1', near: 'L1', cosmos: 'L1', sui: 'L1', aptos: 'L1',
      uniswap: 'DeFi', aave: 'DeFi', maker: 'DeFi', compound: 'DeFi', curve: 'DeFi',
      lido: 'DeFi', sushi: 'DeFi', pancakeswap: 'DeFi', jupiter: 'DeFi',
      arbitrum: 'L2', optimism: 'L2', polygon: 'L2', 'starknet': 'L2', base: 'L2',
      'zksync': 'L2', mantle: 'L2',
    };

    const tokenCategory = TOKEN_CATEGORIES[token];
    if (tokenCategory && portfolioValue > 0) {
      const correlatedExposure = this.portfolio.positions
        .filter((p) => TOKEN_CATEGORIES[p.tokenId] === tokenCategory)
        .reduce((sum, p) => sum + p.quantity * p.currentPrice, 0);
      const newExposure = (correlatedExposure + sizeUsd) / portfolioValue;
      if (newExposure > this.config.maxCorrelatedExposure) {
        return {
          allowed: false,
          reason: `Correlated exposure for ${tokenCategory} would be ${(newExposure * 100).toFixed(1)}% (limit: ${(this.config.maxCorrelatedExposure * 100).toFixed(0)}%)`,
        };
      }
    }

    return { allowed: true };
  }

  /** Calculate position size using classic risk-based formula */
  calculatePositionSize(
    entryPrice: number,
    stopLossPrice: number,
    portfolioValue: number,
    maxRiskPercent?: number,
  ): { quantity: number; sizeUsd: number; riskUsd: number } {
    // Guard against invalid inputs
    if (entryPrice <= 0 || portfolioValue <= 0) {
      return { quantity: 0, sizeUsd: 0, riskUsd: 0 };
    }

    const riskPct = maxRiskPercent ?? this.config.riskPerTrade;
    let riskUsd = portfolioValue * riskPct;
    const riskPerUnit = Math.abs(entryPrice - stopLossPrice);

    if (riskPerUnit <= 0) {
      return { quantity: 0, sizeUsd: 0, riskUsd: 0 };
    }

    // positionSize = (portfolioValue * maxRiskPercent) / (entryPrice - stopLossPrice)
    let quantity = riskUsd / riskPerUnit;
    let sizeUsd = quantity * entryPrice;

    // Cap at max single position size FIRST — floor must not exceed cap.
    const maxSizeUsd = portfolioValue * this.config.maxSinglePosition;
    if (sizeUsd > maxSizeUsd) {
      sizeUsd = maxSizeUsd;
      quantity = maxSizeUsd / entryPrice;
      riskUsd = quantity * riskPerUnit;
    }

    // Minimum position floor: Hyperliquid requires ~$10+ notional per order.
    // Applied AFTER the cap so floor never exceeds maxSinglePosition.
    // Only scales up if vault can afford 2× the floor (safety buffer).
    const MIN_POSITION_USD = 15;
    const effectiveFloor = Math.min(MIN_POSITION_USD, maxSizeUsd);
    if (sizeUsd < effectiveFloor && portfolioValue >= MIN_POSITION_USD * 2) {
      sizeUsd = effectiveFloor;
      quantity = sizeUsd / entryPrice;
      riskUsd = quantity * riskPerUnit;
    }

    return { quantity, sizeUsd, riskUsd };
  }

  /**
   * Enhanced position sizing with uncertainty-aware scaling.
   * Applies uncertainty multiplier to reduce position size in high-uncertainty conditions.
   */
  calculateUncertaintyAwarePositionSize(
    entryPrice: number,
    stopLossPrice: number,
    portfolioValue: number,
    uncertaintyMetrics: UncertaintyMetrics,
    maxRiskPercent?: number,
  ): {
    quantity: number;
    sizeUsd: number;
    riskUsd: number;
    baseSize: number; // Size before uncertainty adjustment
    uncertaintyAdjustment: number; // Multiplier applied
  } {
    // Get base position size using existing logic
    const basePosition = this.calculatePositionSize(
      entryPrice,
      stopLossPrice,
      portfolioValue,
      maxRiskPercent
    );

    // Apply uncertainty scaling to size (not risk - keep risk budget consistent)
    const adjustedSizeUsd = basePosition.sizeUsd * uncertaintyMetrics.sizeMultiplier;
    const adjustedQuantity = adjustedSizeUsd / entryPrice;

    // Risk stays proportional to adjusted position
    const riskPerUnit = Math.abs(entryPrice - stopLossPrice);
    const adjustedRiskUsd = adjustedQuantity * riskPerUnit;

    return {
      quantity: adjustedQuantity,
      sizeUsd: adjustedSizeUsd,
      riskUsd: adjustedRiskUsd,
      baseSize: basePosition.sizeUsd,
      uncertaintyAdjustment: uncertaintyMetrics.sizeMultiplier,
    };
  }

  /** Check drawdown limits — returns true if trading should be paused */
  isDrawdownLimitHit(): { paused: boolean; level: 'daily' | 'weekly' | 'monthly' | null; message: string } {
    const portfolioValue = this.portfolio.totalValue || this.portfolio.cash;
    if (portfolioValue <= 0) {
      return { paused: false, level: null, message: 'No portfolio value set' };
    }

    const dailyPct = Math.abs(this.portfolio.dailyPnl) / portfolioValue;
    const weeklyPct = Math.abs(this.portfolio.weeklyPnl) / portfolioValue;
    const monthlyPct = Math.abs(this.portfolio.monthlyPnl) / portfolioValue;

    if (this.portfolio.dailyPnl < 0 && dailyPct >= this.config.dailyLossLimit) {
      return {
        paused: true,
        level: 'daily',
        message: `Daily loss limit hit: ${(dailyPct * 100).toFixed(1)}% (limit: ${(this.config.dailyLossLimit * 100).toFixed(0)}%)`,
      };
    }

    if (this.portfolio.weeklyPnl < 0 && weeklyPct >= this.config.weeklyLossLimit) {
      return {
        paused: true,
        level: 'weekly',
        message: `Weekly loss limit hit: ${(weeklyPct * 100).toFixed(1)}% (limit: ${(this.config.weeklyLossLimit * 100).toFixed(0)}%)`,
      };
    }

    if (this.portfolio.monthlyPnl < 0 && monthlyPct >= this.config.monthlyLossLimit) {
      return {
        paused: true,
        level: 'monthly',
        message: `Monthly loss limit hit: ${(monthlyPct * 100).toFixed(1)}% (limit: ${(this.config.monthlyLossLimit * 100).toFixed(0)}%)`,
      };
    }

    return { paused: false, level: null, message: 'Within limits' };
  }

  /**
   * Ratchet stop-losses each cycle based on current prices.
   * Applies three independent mechanisms, whichever gives the tightest stop:
   *
   *   1. Breakeven: if PnL% crosses +breakevenTriggerPct, move stop to entryPrice.
   *      Locks in "no loss" once the trade is meaningfully in the money.
   *
   *   2. Orca-inspired HWM profit-lock (see README / PR #223): stepped table
   *      keyed on "gain from entry". Each triggered tier locks a growing
   *      fraction of the peak-to-date move:
   *        LONG:  stop = entry + (peakPrice - entry) * lockPct
   *        SHORT: stop = entry - (entry - peakPrice) * lockPct
   *      `peakPrice` tracks the best price observed since entry and is
   *      updated on every call (max for LONG, min for SHORT). A retrace
   *      followed by a new peak advances the lock — never resets it.
   *
   *   3. Percent-trail: stop tracks currentPrice × (1 ± trailingStopPct).
   *      Continuous trail — tracks new highs (LONG) / lows (SHORT).
   *
   * All mechanisms respect the "stops never loosen" invariant.
   * `peakPrice` is updated even when no stop-change fires (so future
   * cycles see the ratchet). Returns a new array — does not mutate input.
   *
   * Legacy positions loaded from portfolio.json without `peakPrice`
   * default to `entryPrice` (safest — never triggers a tier on the
   * first cycle after upgrade until price actually advances).
   */
  updateTrailingStops(positions: Position[]): Position[] {
    return positions.map((pos) => {
      if (pos.currentPrice <= 0 || pos.entryPrice <= 0) return pos;

      const isShort = pos.side === 'short';

      // Update peak-price HWM. For LONG, peak = max observed price.
      // For SHORT, peak = min observed price (most favorable for a short).
      // Legacy positions without `peakPrice` seed from entryPrice — this
      // is the safer default: on the first post-upgrade cycle, no HWM
      // tier will fire until price actually moves beyond entry.
      const priorPeak = Number.isFinite(pos.peakPrice) ? (pos.peakPrice as number) : pos.entryPrice;
      const newPeak = isShort
        ? Math.min(priorPeak, pos.currentPrice)
        : Math.max(priorPeak, pos.currentPrice);

      // Direction-aware PnL from entry
      const pnlPct = isShort
        ? (pos.entryPrice - pos.currentPrice) / (pos.entryPrice || 1)
        : (pos.currentPrice - pos.entryPrice) / (pos.entryPrice || 1);
      let newStop = pos.stopLoss;

      if (isShort) {
        // For SHORTS: stops sit ABOVE price. "Tighter" = LOWER.

        // 1. Breakeven: move stop down to entry
        if (this.config.breakevenTriggerPct > 0 && pnlPct >= this.config.breakevenTriggerPct) {
          newStop = Math.min(newStop, pos.entryPrice);
        }

        // 2. HWM profit-lock. For shorts, the peak is the lowest price.
        //    stop = entry - (entry - peak) * lockPct  (peak <= entry)
        //    Iterate tiers — highest-triggered tier wins.
        for (const step of this.config.profitLockSteps) {
          if (pnlPct >= step.trigger) {
            const lockedStop = pos.entryPrice - (pos.entryPrice - newPeak) * step.lockPct;
            newStop = Math.min(newStop, lockedStop);
          }
        }

        // 3. Percent-trail: track new lows
        if (this.config.trailingStopPct > 0) {
          const trailStop = pos.currentPrice * (1 + this.config.trailingStopPct);
          newStop = Math.min(newStop, trailStop);
        }

        if (newStop < pos.stopLoss || newPeak !== priorPeak) {
          return {
            ...pos,
            peakPrice: newPeak,
            stopLoss: newStop < pos.stopLoss ? newStop : pos.stopLoss,
            trailingStop: newStop < pos.stopLoss ? newStop : pos.trailingStop,
          };
        }
      } else {
        // For LONGS: stops sit BELOW price. "Tighter" = HIGHER.

        // 1. Breakeven
        if (this.config.breakevenTriggerPct > 0 && pnlPct >= this.config.breakevenTriggerPct) {
          newStop = Math.max(newStop, pos.entryPrice);
        }

        // 2. HWM profit-lock.
        //    stop = entry + (peak - entry) * lockPct  (peak >= entry)
        for (const step of this.config.profitLockSteps) {
          if (pnlPct >= step.trigger) {
            const lockedStop = pos.entryPrice + (newPeak - pos.entryPrice) * step.lockPct;
            newStop = Math.max(newStop, lockedStop);
          }
        }

        // 3. Percent-trail
        if (this.config.trailingStopPct > 0) {
          const trailStop = pos.currentPrice * (1 - this.config.trailingStopPct);
          newStop = Math.max(newStop, trailStop);
        }

        if (newStop > pos.stopLoss || newPeak !== priorPeak) {
          return {
            ...pos,
            peakPrice: newPeak,
            stopLoss: newStop > pos.stopLoss ? newStop : pos.stopLoss,
            trailingStop: newStop > pos.stopLoss ? newStop : pos.trailingStop,
          };
        }
      }
      return pos;
    });
  }

  /** Update trailing stop losses using ATR values */
  updateStopLosses(positions: Position[], atrValues: Record<string, number>): Position[] {
    return positions.map((pos) => {
      const atr = atrValues[pos.tokenId];
      if (atr === undefined || atr <= 0) return pos;

      const trailingDistance = atr * this.config.trailingStopAtr;
      const currentTrailing = pos.trailingStop ?? pos.stopLoss;

      if (pos.side === 'short') {
        // For SHORTS: stop sits ABOVE current price. Tighten only if new
        // candidate is LOWER than the current trailing stop.
        const newTrailingStop = pos.currentPrice + trailingDistance;
        if (newTrailingStop < currentTrailing) {
          return {
            ...pos,
            trailingStop: newTrailingStop,
            // Also update hard stop if trailing is tighter (lower)
            stopLoss: Math.min(pos.stopLoss, newTrailingStop),
          };
        }
        return pos;
      }

      // LONGS: stop sits BELOW current price. Only move trailing stop up.
      const newTrailingStop = pos.currentPrice - trailingDistance;
      if (newTrailingStop > currentTrailing) {
        return {
          ...pos,
          trailingStop: newTrailingStop,
          // Also update hard stop if trailing is higher
          stopLoss: Math.max(pos.stopLoss, newTrailingStop),
        };
      }

      return pos;
    });
  }

  /** Check if any positions should be closed */
  checkExits(
    positions: Position[],
    currentPrices: Record<string, number>,
  ): { toClose: Position[]; reasons: Record<string, string> } {
    const toClose: Position[] = [];
    const reasons: Record<string, string> = {};

    for (const pos of positions) {
      const price = currentPrices[pos.tokenId];
      if (price === undefined) continue;

      const updatedPos = { ...pos, currentPrice: price };
      const isShort = pos.side === 'short';

      // PnL calculation — direction-aware
      const pnlPercent = isShort
        ? (pos.entryPrice - price) / (pos.entryPrice || 1)
        : (price - pos.entryPrice) / (pos.entryPrice || 1);

      // Hard stop loss check (direction-aware via pnlPercent)
      if (pnlPercent <= -this.config.hardStopPercent) {
        toClose.push(updatedPos);
        reasons[pos.tokenId] = `Hard stop hit: ${(pnlPercent * 100).toFixed(1)}% loss (limit: -${(this.config.hardStopPercent * 100).toFixed(0)}%)`;
        continue;
      }

      // Stop loss check — for shorts, stop is ABOVE entry (price >= stopLoss)
      // for longs, stop is BELOW entry (price <= stopLoss)
      const stopHit = isShort ? price >= pos.stopLoss : price <= pos.stopLoss;
      if (stopHit) {
        toClose.push(updatedPos);
        reasons[pos.tokenId] = `Stop loss hit at $${pos.stopLoss.toFixed(4)} (price: $${price.toFixed(4)})`;
        continue;
      }

      // Trailing stop check — same direction logic as stop loss
      if (pos.trailingStop !== undefined) {
        const trailHit = isShort ? price >= pos.trailingStop : price <= pos.trailingStop;
        if (trailHit) {
          toClose.push(updatedPos);
          reasons[pos.tokenId] = `Trailing stop hit at $${pos.trailingStop.toFixed(4)} (price: $${price.toFixed(4)})`;
          continue;
        }
      }

      // Take profit check — for shorts, TP is BELOW entry (price <= takeProfit)
      // for longs, TP is ABOVE entry (price >= takeProfit)
      const tpHit = isShort ? price <= pos.takeProfit : price >= pos.takeProfit;
      if (tpHit) {
        toClose.push(updatedPos);
        reasons[pos.tokenId] = `Take profit hit at $${pos.takeProfit.toFixed(4)} (price: $${price.toFixed(4)})`;
        continue;
      }

      // Time-based exit: close after 48h if PnL is flat (<1%)
      const holdingHours = (Date.now() - pos.entryTimestamp) / (1000 * 60 * 60);
      if (holdingHours > 48 && pnlPercent < 0.01 && pnlPercent > -0.01) {
        toClose.push(updatedPos);
        reasons[pos.tokenId] = `Time stop: held ${(holdingHours / 24).toFixed(1)} days with only ${(pnlPercent * 100).toFixed(1)}% PnL`;
        continue;
      }
    }

    return { toClose, reasons };
  }

  /** Update portfolio state */
  updatePortfolio(portfolio: Partial<PortfolioState>): void {
    this.portfolio = { ...this.portfolio, ...portfolio };
  }

  /** Get current risk exposure summary */
  getRiskSummary(): string {
    const lines: string[] = [];
    const pv = this.portfolio.totalValue || this.portfolio.cash;

    lines.push(chalk.bold('Risk Summary'));
    lines.push(chalk.dim('─'.repeat(40)));
    lines.push(`Portfolio Value: $${pv.toFixed(2)}`);
    lines.push(`Cash: $${this.portfolio.cash.toFixed(2)}`);
    lines.push(`Open Positions: ${this.portfolio.positions.length}/${this.config.maxConcurrentTrades}`);

    const totalExposure = this.portfolio.positions.reduce(
      (sum, p) => sum + p.quantity * p.currentPrice,
      0,
    );
    const exposurePct = pv > 0 ? (totalExposure / pv) * 100 : 0;
    lines.push(`Total Exposure: $${totalExposure.toFixed(2)} (${exposurePct.toFixed(1)}%)`);

    const totalUnrealizedPnl = this.portfolio.positions.reduce((sum, p) => sum + p.pnlUsd, 0);
    const pnlColor = totalUnrealizedPnl >= 0 ? chalk.green : chalk.red;
    lines.push(`Unrealized PnL: ${pnlColor('$' + totalUnrealizedPnl.toFixed(2))}`);

    lines.push(chalk.dim('─'.repeat(40)));
    lines.push(`Daily PnL: ${this.portfolio.dailyPnl >= 0 ? '+' : ''}$${this.portfolio.dailyPnl.toFixed(2)}`);
    lines.push(`Weekly PnL: ${this.portfolio.weeklyPnl >= 0 ? '+' : ''}$${this.portfolio.weeklyPnl.toFixed(2)}`);
    lines.push(`Monthly PnL: ${this.portfolio.monthlyPnl >= 0 ? '+' : ''}$${this.portfolio.monthlyPnl.toFixed(2)}`);

    const drawdown = this.isDrawdownLimitHit();
    if (drawdown.paused) {
      lines.push(chalk.red(`TRADING PAUSED: ${drawdown.message}`));
    }

    return lines.join('\n');
  }
}
