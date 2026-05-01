/**
 * Grid backtester — replays historical Hyperliquid 1-minute bars through
 * the existing GridManager and reports PnL, fills, drawdown.
 *
 * Uses Approach 2 from the design spec: a separate orchestrator that
 * reuses GridManager via injected dependencies (candle fetcher, fill
 * detectors, in-memory portfolio). Live mode is untouched.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { GridManager, type CandleFetcher } from './manager.js';
import { BacktestPortfolio } from './backtest-portfolio.js';
import { HistoricalDataLoader, type Bar1m, type AtrPoint } from './historical-data-loader.js';
import { type GridConfig } from './config.js';
import { BacktestHedgeManager } from './backtest-hedge.js';

const DEFAULT_OUT_DIR = join(homedir(), '.sherwood', 'grid', 'backtests');

export interface BacktestOpts {
  fromMs: number;
  toMs: number;
  capital: number;
  config: GridConfig;
  /** Equity-curve snapshot cadence in simulated minutes. Default 60. */
  snapshotEveryMinutes?: number;
  /** When true, re-enables the manager's chalk console.error logs. */
  verbose?: boolean;
  /** When true, skips cache for fetch. */
  noCache?: boolean;
  /** Override the default JSON output path. */
  outPath?: string;
  /** Inject for tests — defaults to a real HistoricalDataLoader. */
  loader?: HistoricalDataLoader;
  /** Trading fee in basis points per fill. Default 5 (typical maker). */
  feeBps?: number;
  /** Simulate the GridHedgeManager. Default true (matches live grid). */
  hedge?: boolean;
}

export interface EquityPoint {
  t: number;
  totalAllocation: number;
  totalPnl: number;
  totalRoundTrips: number;
  openFillCount: number;
  paused: boolean;
}

export interface BacktestResult {
  runId: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  window: {
    fromMs: number;
    toMs: number;
    fromIso: string;
    toIso: string;
    days: number;
  };
  config: GridConfig;
  capital: {
    initialUsd: number;
    finalUsd: number;
    pnlUsd: number;        // NET of fees
    pnlPct: number;        // NET of fees
    grossPnlUsd: number;   // before fees (= old pnlUsd value)
  };
  fees: {
    bps: number;
    totalUsd: number;
    perFill: number;       // avg fee per fill in USD (across tokens, weighted)
  };
  hedge: {
    enabled: boolean;
    realizedPnlUsd: number;
    unrealizedPnlUsd: number;          // at end of run
    adjustments: number;                // total hedge adjustments across the run
    finalOpenPositions: number;         // count of open shorts at end
  };
  liquidations: {
    /** Per-token liquidation events. */
    events: Array<{
      token: string;
      timestamp: number;
      tokenAllocation: number;
      unrealizedPnlAtLiquidation: number;
      thresholdUsd: number;
    }>;
    /** When all configured tokens are liquidated, the run terminates here. Null if not all liquidated. */
    haltedAt: number | null;
  };
  totals: {
    roundTrips: number;
    fills: number;
    rebuilds: number;
    pausedSteps: number;
    skippedSteps: number;
    totalSteps: number;
  };
  perToken: Array<{
    token: string;
    allocation: { initial: number; final: number };
    roundTrips: number;
    fills: number;
    pnlUsd: number;
    rebuilds: number;
  }>;
  drawdown: {
    maxUsd: number;
    maxPct: number;
    peakAt: number;
    troughAt: number;
  };
  equityCurve: EquityPoint[];
}

/** Compute a deterministic 8-char hash from window+config for run ID. */
export function shortHash(input: { fromMs: number; toMs: number; config: GridConfig }): string {
  const h = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return h.slice(0, 8);
}

/** Compute peak-to-trough drawdown from an equity curve. */
export function computeDrawdown(curve: EquityPoint[]): BacktestResult['drawdown'] {
  if (curve.length === 0) {
    return { maxUsd: 0, maxPct: 0, peakAt: 0, troughAt: 0 };
  }
  const equityAt = (p: EquityPoint) => p.totalAllocation + p.totalPnl;
  let peak = equityAt(curve[0]!);
  let peakAt = curve[0]!.t;
  let maxDrop = 0;
  let dropPeakAt = peakAt;
  let dropTroughAt = peakAt;
  for (const point of curve) {
    const eq = equityAt(point);
    if (eq > peak) {
      peak = eq;
      peakAt = point.t;
    }
    const drop = peak - eq;
    if (drop > maxDrop) {
      maxDrop = drop;
      dropPeakAt = peakAt;
      dropTroughAt = point.t;
    }
  }
  const peakPoint = curve.find(p => p.t === dropPeakAt);
  const peakValue = peakPoint ? equityAt(peakPoint) : 0;
  return {
    maxUsd: maxDrop,
    maxPct: peakValue > 0 ? maxDrop / peakValue : 0,
    peakAt: dropPeakAt,
    troughAt: dropTroughAt,
  };
}

function isoToYmdHms(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export function makeRunId(fromMs: number, toMs: number, config: GridConfig): string {
  return `bt-${isoToYmdHms(Date.now())}-${shortHash({ fromMs, toMs, config })}`;
}

/**
 * Run a backtest. Returns the structured result; also writes JSON to disk
 * unless outPath is the empty string ''.
 */
export async function runBacktest(opts: BacktestOpts): Promise<BacktestResult> {
  const startedAt = Date.now();

  // Validation
  if (opts.fromMs >= opts.toMs) throw new Error('--from must be before --to');
  const FIFTY_SIX_HOURS = 56 * 60 * 60 * 1000;
  if (opts.toMs - opts.fromMs < FIFTY_SIX_HOURS) {
    throw new Error('window too short — need ≥ 56h for ATR(14) warmup');
  }
  const splitSum = Object.values(opts.config.tokenSplit).reduce((a, b) => a + b, 0);
  if (Math.abs(splitSum - 1.0) > 1e-6) {
    throw new Error(`tokenSplit must sum to 1.0, got ${splitSum.toFixed(6)}`);
  }

  const loader = opts.loader ?? new HistoricalDataLoader({ noCache: opts.noCache });
  const snapshotEvery = opts.snapshotEveryMinutes ?? 60;

  // Load all token series in parallel
  const seriesByToken: Record<string, { minutes: Bar1m[]; fourHour: Bar1m[]; atrSeries: AtrPoint[] }> = {};
  await Promise.all(opts.config.tokens.map(async token => {
    seriesByToken[token] = await loader.load(token, opts.fromMs, opts.toMs);
  }));

  // Build unified timeline: minutes present in ALL token series
  const minuteSets = opts.config.tokens.map(t => new Set(seriesByToken[t]!.minutes.map(b => b.t)));
  const masterMinutes = seriesByToken[opts.config.tokens[0]!]!.minutes;
  const sharedTimestamps: number[] = [];
  let skippedSteps = 0;
  for (const bar of masterMinutes) {
    if (bar.t < opts.fromMs || bar.t >= opts.toMs) continue;
    if (minuteSets.every(s => s.has(bar.t))) {
      sharedTimestamps.push(bar.t);
    } else {
      skippedSteps++;
    }
  }

  if (sharedTimestamps.length === 0) {
    throw new Error('no overlapping bars across requested tokens');
  }

  // Index lookup: token → timestamp → bar
  const barIndex: Record<string, Map<number, Bar1m>> = {};
  for (const token of opts.config.tokens) {
    const m = new Map<number, Bar1m>();
    for (const bar of seriesByToken[token]!.minutes) m.set(bar.t, bar);
    barIndex[token] = m;
  }

  // Backtest clock injection
  let currentT = sharedTimestamps[0]!;
  const nowProvider = () => currentT;

  // Candle fetcher: returns 4h bars whose close ts ≤ currentT (point-in-time correct)
  const candleFetcher: CandleFetcher = async (tokenId, interval, lookbackMs) => {
    if (interval !== '4h') return null;
    const series = seriesByToken[tokenId];
    if (!series) return null;
    const cutoff = currentT - lookbackMs;
    return series.fourHour
      .filter(b => b.t <= currentT && b.t >= cutoff)
      .map(b => ({
        timestamp: b.t,
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
      }));
  };

  // Construct manager with default close-only detectors. HLC fills are
  // implemented via TWO-PASS TICK: each step calls manager.tick twice
  // — once with bar.low (triggers buys), once with bar.high (triggers
  // sells + closes opens). Default close-only detector then fires at
  // the right times. No per-token detector context required.
  const portfolio = new BacktestPortfolio(nowProvider);
  const manager = new GridManager(opts.config, candleFetcher, undefined, undefined, portfolio, nowProvider);

  // Initialize portfolio with starting capital
  await manager.init(opts.capital);

  // Snapshot initial per-token allocation. Used only for fee notional
  // approximation (notionalPerFillByToken). Allocation compounding is now
  // live — grid.allocation += profit each step, matching live-mode behavior.
  // (Fee approx slightly understates fees as allocation compounds upward;
  // acceptable for v1 and can be refined later.)
  const initialAllocations: Record<string, number> = {};
  {
    const initState = portfolio.getState();
    if (initState) {
      for (const grid of initState.grids) {
        initialAllocations[grid.token] = grid.allocation;
      }
    }
  }

  // Pre-compute per-token notional-per-fill (used for running fee accrual)
  const feeBps = opts.feeBps ?? 5;
  const notionalPerFillByToken: Record<string, number> = {};
  for (const token of opts.config.tokens) {
    const tokenInitial = initialAllocations[token] ?? 0;
    notionalPerFillByToken[token] = (tokenInitial * opts.config.leverage) / opts.config.levelsPerSide;
  }

  // Running fee accumulators (kept in sync with equity curve)
  const feesByToken: Record<string, number> = {};
  for (const token of opts.config.tokens) feesByToken[token] = 0;
  const lastSeenFills: Record<string, number> = {};
  for (const token of opts.config.tokens) lastSeenFills[token] = 0;

  const hedgeEnabled = opts.hedge ?? true;
  const hedge = new BacktestHedgeManager(nowProvider);
  let hedgeAdjustments = 0;
  let hedgeRealized = 0;
  let hedgeUnrealized = 0;

  // Track rebuild count via portfolio state (manager updates grid.stats.lastRebalanceAt)
  let totalRebuilds = 0;
  const lastRebalanceAt: Record<string, number> = {};
  for (const t of opts.config.tokens) lastRebalanceAt[t] = 0;

  // Liquidation tracking. A token is liquidated when its unrealized PnL
  // exceeds the calibrated maintenance threshold; once liquidated, the
  // token's grid is frozen (existing opens cleared as realized losses, no
  // new fills allowed). When all tokens are liquidated the run halts.
  const liquidatedTokens = new Set<string>();
  const liquidationEvents: BacktestResult['liquidations']['events'] = [];
  let haltedAt: number | null = null;

  // Equity curve
  const equityCurve: EquityPoint[] = [];
  let pausedSteps = 0;

  // Silence manager's chalk logs unless verbose
  const originalConsoleError = console.error;
  if (!opts.verbose) {
    console.error = () => {};
  }

  try {
    let cycleCount = 0;
    const totalSteps = sharedTimestamps.length;
    const decileSize = Math.max(1, Math.floor(totalSteps / 10));

    for (const t of sharedTimestamps) {
      currentT = t;

      // Per-token pass order inferred from bar color (option B):
      // green (close >= open): price went low → high → buy fills (Pass 1=low),
      //   then close-outs may fire on the way up (Pass 2=high) — same-bar
      //   round trip is realistic.
      // red (close < open): price went high → low → close-outs fire first
      //   (Pass 1=high) on pre-existing opens. New buys from Pass 2=low can't
      //   close this bar because low < target — no same-bar round trip.
      // Doji (close == open) treated as green.
      const passAPrices: Record<string, number> = {};
      const passBPrices: Record<string, number> = {};
      for (const token of opts.config.tokens) {
        const bar = barIndex[token]!.get(t)!;
        const isGreen = bar.c >= bar.o;
        passAPrices[token] = isGreen ? bar.l : bar.h;
        passBPrices[token] = isGreen ? bar.h : bar.l;
      }

      const r1 = await manager.tick(passAPrices);
      const r2 = await manager.tick(passBPrices);

      // Detect rebuilds — manager updates grid.stats.lastRebalanceAt
      const stateAfter = portfolio.getState();
      if (stateAfter) {
        for (const grid of stateAfter.grids) {
          if (grid.stats.lastRebalanceAt > lastRebalanceAt[grid.token]!) {
            totalRebuilds++;
            lastRebalanceAt[grid.token] = grid.stats.lastRebalanceAt;
          }
        }
      }

      if (r1.paused || r2.paused) pausedSteps++;

      // Hedge tick: uses bar.close prices and the manager's open-fill exposure.
      if (hedgeEnabled) {
        const hedgePrices: Record<string, number> = {};
        for (const token of opts.config.tokens) {
          const bar = barIndex[token]!.get(t)!;
          hedgePrices[token] = bar.c;
        }
        const exposure = manager.getOpenFillExposure();
        const hedgeResult = await hedge.tick(exposure, hedgePrices, t);
        hedgeAdjustments += hedgeResult.adjustments;
        hedgeRealized = hedgeResult.totalRealizedPnl;
        hedgeUnrealized = hedgeResult.unrealizedPnl;
      }

      // Accrue per-step fees: any new fills this step pay notionalPerFill × bps / 10_000
      if (stateAfter) {
        for (const grid of stateAfter.grids) {
          const newFills = grid.stats.totalFills - lastSeenFills[grid.token]!;
          if (newFills > 0) {
            feesByToken[grid.token]! += newFills * (notionalPerFillByToken[grid.token] ?? 0) * feeBps / 10_000;
            lastSeenFills[grid.token] = grid.stats.totalFills;
          }
        }
      }

      // Liquidation check: per token, sum unrealized PnL on its open fills
      // and compare against the calibrated threshold.
      // Threshold is in the backtester's overstated unrealized-PnL units (see
      // the leverage double-count caveat).
      const stateLiq = portfolio.getState();
      if (stateLiq && haltedAt === null) {
        const lev = opts.config.leverage;
        const maint = opts.config.maintenanceMarginPct;
        // Now that the manager's PnL formula no longer double-counts leverage,
        // unrealized in this loop is the REAL dollar PnL. Threshold drops
        // by a factor of leverage vs. the previous (overstated) calibration:
        //   real-world liquidation at (1/lev - maint) adverse move →
        //   unrealized loss = allocation - allocation × lev × maint
        //   = allocation × (1 - lev × maint).
        const liquidationCoefficient = 1 - lev * maint;
        for (const grid of stateLiq.grids) {
          if (liquidatedTokens.has(grid.token)) continue;
          const close = barIndex[grid.token]?.get(t)?.c;
          if (close === undefined) continue;
          let unrealized = 0;
          for (const f of grid.openFills) {
            if (f.closed) continue;
            unrealized += (close - f.buyPrice) * f.quantity;
          }
          const tokenAlloc = initialAllocations[grid.token] ?? 0;
          const threshold = -tokenAlloc * liquidationCoefficient;
          if (tokenAlloc > 0 && unrealized <= threshold) {
            // Realize the loss and freeze the grid for this token.
            grid.stats.totalPnlUsd += unrealized;
            grid.stats.todayPnlUsd += unrealized;
            grid.allocation += unrealized; // bookkeeping; allocation now near-zero
            for (const f of grid.openFills) {
              if (!f.closed) {
                f.closed = true;
                f.closedAt = t;
                f.pnlUsd = (close - f.buyPrice) * f.quantity;
              }
            }
            // Drop the level grid so manager doesn't fire new fills
            grid.levels = [];
            liquidatedTokens.add(grid.token);
            liquidationEvents.push({
              token: grid.token,
              timestamp: t,
              tokenAllocation: tokenAlloc,
              unrealizedPnlAtLiquidation: unrealized,
              thresholdUsd: threshold,
            });
            // Stderr notice (always, not gated on verbose — this is a serious event)
            process.stderr.write(
              `  [backtest] LIQUIDATED ${grid.token} at t=${new Date(t).toISOString()}: unrealized=$${unrealized.toFixed(0)} (threshold=$${threshold.toFixed(0)})\n`
            );
          }
        }
        // If all configured tokens are liquidated, halt the run
        if (liquidatedTokens.size === opts.config.tokens.length) {
          haltedAt = t;
          process.stderr.write(`  [backtest] All tokens liquidated; halting run at t=${new Date(t).toISOString()}\n`);
        }
      }

      if (haltedAt !== null) {
        // Capture a final snapshot at halt, then break
        const sFinal = portfolio.getState();
        if (sFinal) {
          const aggFinal = portfolio.aggregateStats(sFinal);
          const ofcFinal = sFinal.grids.reduce((sum, g) => sum + g.openFills.filter(f => !f.closed).length, 0);
          const runningFeesFinal = Object.values(feesByToken).reduce((a, b) => a + b, 0);
          equityCurve.push({
            t,
            totalAllocation: sFinal.totalAllocation,
            totalPnl: aggFinal.totalPnlUsd - runningFeesFinal + hedgeRealized + hedgeUnrealized,
            totalRoundTrips: aggFinal.totalRoundTrips,
            openFillCount: ofcFinal,
            paused: sFinal.paused,
          });
        }
        break;
      }

      // Snapshot
      cycleCount++;
      if (cycleCount % snapshotEvery === 0 || cycleCount === totalSteps) {
        const s = portfolio.getState();
        if (s) {
          const agg = portfolio.aggregateStats(s);
          const openFillCount = s.grids.reduce(
            (sum, g) => sum + g.openFills.filter(f => !f.closed).length,
            0,
          );
          // Mark open positions to market at the current bar's close.
          // Without this, drawdown is always 0 because the grid only books
          // realized PnL on profitable closes — open underwater buys never
          // show up in equity.
          let unrealizedPnl = 0;
          for (const grid of s.grids) {
            const close = barIndex[grid.token]?.get(t)?.c;
            if (close === undefined) continue;
            for (const f of grid.openFills) {
              if (f.closed) continue;
              // quantity already leveraged — see manager.simulateFills note.
              unrealizedPnl += (close - f.buyPrice) * f.quantity;
            }
          }
          const runningFees = Object.values(feesByToken).reduce((a, b) => a + b, 0);
          equityCurve.push({
            t,
            totalAllocation: s.totalAllocation,
            totalPnl: agg.totalPnlUsd + unrealizedPnl - runningFees + hedgeRealized + hedgeUnrealized,
            totalRoundTrips: agg.totalRoundTrips,
            openFillCount,
            paused: s.paused,
          });
        }
      }

      // Progress (10% increments)
      if (cycleCount % decileSize === 0) {
        if (opts.verbose) {
          originalConsoleError(`  [backtest] ${Math.round((cycleCount / totalSteps) * 100)}%  step ${cycleCount}/${totalSteps}`);
        } else {
          process.stderr.write(`  [backtest] ${Math.round((cycleCount / totalSteps) * 100)}%  step ${cycleCount}/${totalSteps}\n`);
        }
      }
    }
  } finally {
    console.error = originalConsoleError;
  }

  // Build result
  const finalState = portfolio.getState()!;
  const agg = portfolio.aggregateStats(finalState);

  const finishedAt = Date.now();
  const runId = makeRunId(opts.fromMs, opts.toMs, opts.config);

  const initialPerToken: Record<string, number> = {};
  for (const token of opts.config.tokens) {
    initialPerToken[token] = opts.capital * (opts.config.tokenSplit[token] ?? 0);
  }

  // Fee totals from running accumulators (co-evolves with equity curve)
  const totalFeesUsd = Object.values(feesByToken).reduce((a, b) => a + b, 0);
  const totalFills = finalState.grids.reduce((s, g) => s + g.stats.totalFills, 0);
  const avgFeePerFill = totalFills > 0 ? totalFeesUsd / totalFills : 0;

  const grossPnl = agg.totalPnlUsd;
  const netPnl = grossPnl - totalFeesUsd;

  const hedgeStatus = hedgeEnabled ? hedge.getStatus() : null;
  const hedgePnl = hedgeRealized + hedgeUnrealized;
  const finalNetPnl = netPnl + hedgePnl;

  // Per-token rebuild count not preserved separately; total in totals.rebuilds.
  const perToken = finalState.grids.map(g => ({
    token: g.token,
    allocation: { initial: initialPerToken[g.token] ?? 0, final: g.allocation },
    roundTrips: g.stats.totalRoundTrips,
    fills: g.stats.totalFills,
    pnlUsd: g.stats.totalPnlUsd,
    rebuilds: 0,
  }));

  const result: BacktestResult = {
    runId,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    window: {
      fromMs: opts.fromMs,
      toMs: opts.toMs,
      fromIso: new Date(opts.fromMs).toISOString(),
      toIso: new Date(opts.toMs).toISOString(),
      days: (opts.toMs - opts.fromMs) / (24 * 60 * 60 * 1000),
    },
    config: opts.config,
    capital: {
      initialUsd: opts.capital,
      finalUsd: opts.capital + finalNetPnl,
      pnlUsd: finalNetPnl,
      pnlPct: finalNetPnl / opts.capital,
      grossPnlUsd: grossPnl,
    },
    fees: {
      bps: feeBps,
      totalUsd: totalFeesUsd,
      perFill: avgFeePerFill,
    },
    hedge: {
      enabled: hedgeEnabled,
      realizedPnlUsd: hedgeRealized,
      unrealizedPnlUsd: hedgeUnrealized,
      adjustments: hedgeAdjustments,
      finalOpenPositions: hedgeStatus ? hedgeStatus.positions.length : 0,
    },
    liquidations: {
      events: liquidationEvents,
      haltedAt,
    },
    totals: {
      roundTrips: agg.totalRoundTrips,
      fills: finalState.grids.reduce((s, g) => s + g.stats.totalFills, 0),
      rebuilds: totalRebuilds,
      pausedSteps,
      skippedSteps,
      totalSteps: sharedTimestamps.length,
    },
    perToken,
    drawdown: computeDrawdown(equityCurve),
    equityCurve,
  };

  // Write JSON output (skip if outPath is empty string)
  if (opts.outPath !== '') {
    const outPath = opts.outPath ?? join(DEFAULT_OUT_DIR, `${runId}.json`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(result, null, 2), 'utf-8');
  }

  return result;
}
