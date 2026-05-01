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
import chalk from 'chalk';
import { GridManager, type FillDetector, type CloseFillDetector, type CandleFetcher } from './manager.js';
import { BacktestPortfolio } from './backtest-portfolio.js';
import { HistoricalDataLoader, lookupAtr, type Bar1m, type AtrPoint } from './historical-data-loader.js';
import { DEFAULT_GRID_CONFIG, type GridConfig, type GridLevel, type GridFill } from './config.js';

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
