/**
 * Grid backtester — replays historical Hyperliquid 1-minute bars through
 * the existing GridManager and reports PnL, fills, drawdown.
 *
 * Uses Approach 2 from the design spec: a separate orchestrator that
 * reuses GridManager via injected dependencies (candle fetcher, fill
 * detectors, in-memory portfolio). Live mode is untouched.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { GridManager, type CandleFetcher } from './manager.js';
import { BacktestPortfolio } from './backtest-portfolio.js';
import { HistoricalDataLoader, type Bar1m, type AtrPoint } from './historical-data-loader.js';
import { type GridConfig } from './config.js';

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
    pnlUsd: number;
    pnlPct: number;
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
  let peak = curve[0]!.totalAllocation;
  let peakAt = curve[0]!.t;
  let maxDrop = 0;
  let dropPeakAt = peakAt;
  let dropTroughAt = peakAt;
  for (const point of curve) {
    if (point.totalAllocation > peak) {
      peak = point.totalAllocation;
      peakAt = point.t;
    }
    const drop = peak - point.totalAllocation;
    if (drop > maxDrop) {
      maxDrop = drop;
      dropPeakAt = peakAt;
      dropTroughAt = point.t;
    }
  }
  const peakValue = curve.find(p => p.t === dropPeakAt)?.totalAllocation ?? 0;
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
  const candleFetcher: CandleFetcher = async (tokenId, interval, _lookbackMs) => {
    if (interval !== '4h') return null;
    const series = seriesByToken[tokenId];
    if (!series) return null;
    return series.fourHour
      .filter(b => b.t <= currentT)
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
  const manager = new GridManager(opts.config, candleFetcher, undefined, undefined, portfolio);

  // Initialize portfolio with starting capital
  await manager.init(opts.capital);

  // Track rebuild count via portfolio state (manager updates grid.stats.lastRebalanceAt)
  let totalRebuilds = 0;
  const lastRebalanceAt: Record<string, number> = {};
  for (const t of opts.config.tokens) lastRebalanceAt[t] = 0;

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

      // Build per-token bar.low and bar.high price maps
      const buyPrices: Record<string, number> = {};
      const sellPrices: Record<string, number> = {};
      for (const token of opts.config.tokens) {
        const bar = barIndex[token]!.get(t)!;
        buyPrices[token] = bar.l;
        sellPrices[token] = bar.h;
      }

      // Pass 1 (low): triggers buys
      const r1 = await manager.tick(buyPrices);
      // Pass 2 (high): triggers sells + closes opens
      const r2 = await manager.tick(sellPrices);

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

      // Snapshot
      cycleCount++;
      if (cycleCount % snapshotEvery === 0 || cycleCount === totalSteps) {
        const s = portfolio.getState();
        if (s) {
          const agg = portfolio.aggregateStats(s);
          const openFillCount = s.grids.reduce((sum, g) => sum + g.openFills.filter(f => !f.closed).length, 0);
          equityCurve.push({
            t,
            totalAllocation: s.totalAllocation,
            totalPnl: agg.totalPnlUsd,
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
      finalUsd: opts.capital + agg.totalPnlUsd,
      pnlUsd: agg.totalPnlUsd,
      pnlPct: agg.totalPnlUsd / opts.capital,
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
    await mkdir(DEFAULT_OUT_DIR, { recursive: true });
    await writeFile(outPath, JSON.stringify(result, null, 2), 'utf-8');
  }

  return result;
}
