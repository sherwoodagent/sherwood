/**
 * Parameter sweep for the grid backtester.
 *
 * Runs runBacktest over a Cartesian product of parameter values, sharing
 * one HistoricalDataLoader so the data is fetched once. Useful for
 * comparing leverage / level count / ATR multiplier / drift trade-offs
 * over the same window.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { runBacktest, type BacktestResult } from './backtest.js';
import { HistoricalDataLoader } from './historical-data-loader.js';
import { DEFAULT_GRID_CONFIG, type GridConfig } from './config.js';

const DEFAULT_SWEEP_DIR = join(homedir(), '.sherwood', 'grid', 'sweeps');

export type SweepableField = 'leverage' | 'levelsPerSide' | 'atrMultiplier' | 'rebalanceDriftPct';

export interface SweepOpts {
  fromMs: number;
  toMs: number;
  capital: number;
  tokens: string[];
  /** Optional explicit token weights (must sum to 1.0). Defaults to equal weight. */
  tokenSplit?: Record<string, number>;
  /** Base config; sweep params override per run. tokenSplit auto-computed. */
  baseConfig?: Partial<GridConfig>;
  /** Map of sweepable field name → list of values to try. Empty list means use base value. */
  sweep: Partial<Record<SweepableField, number[]>>;
  /** Trading fee bps. Default 5. */
  feeBps?: number;
  /** Output dir for sweep result + per-run files. */
  outDir?: string;
  /** Skip cache for HL fetches. */
  noCache?: boolean;
  /** Print progress per run. Default true. */
  verbose?: boolean;
}

export interface SweepRunSummary {
  index: number;
  config: Partial<Record<SweepableField, number>>;
  runId: string;
  resultPath: string;
  capital: { initialUsd: number; finalUsd: number; pnlUsd: number; pnlPct: number; grossPnlUsd: number };
  fees: { bps: number; totalUsd: number };
  totals: { roundTrips: number; fills: number; pausedSteps: number };
  drawdown: { maxUsd: number; maxPct: number };
  /** Net PnL pct divided by max(abs(drawdown pct), 1). Higher = better risk-adjusted. */
  riskAdjusted: number;
  /** True if no full liquidation halt occurred. Per-token liquidations still count as survived if not all tokens died. */
  survived: boolean;
  durationMs: number;
}

export interface SweepResult {
  sweepId: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  window: { fromMs: number; toMs: number; days: number };
  tokens: string[];
  capital: number;
  feeBps: number;
  /** Cartesian-product run summaries, sorted by riskAdjusted desc. */
  runs: SweepRunSummary[];
}

/** Build the Cartesian product of parameter combinations. */
export function expandSweep(
  sweep: Partial<Record<SweepableField, number[]>>,
  base: Pick<GridConfig, 'leverage' | 'levelsPerSide' | 'atrMultiplier' | 'rebalanceDriftPct'>,
): Array<Record<SweepableField, number>> {
  const fields: SweepableField[] = ['leverage', 'levelsPerSide', 'atrMultiplier', 'rebalanceDriftPct'];
  const valueLists: Record<SweepableField, number[]> = {
    leverage: sweep.leverage && sweep.leverage.length > 0 ? sweep.leverage : [base.leverage],
    levelsPerSide: sweep.levelsPerSide && sweep.levelsPerSide.length > 0 ? sweep.levelsPerSide : [base.levelsPerSide],
    atrMultiplier: sweep.atrMultiplier && sweep.atrMultiplier.length > 0 ? sweep.atrMultiplier : [base.atrMultiplier],
    rebalanceDriftPct: sweep.rebalanceDriftPct && sweep.rebalanceDriftPct.length > 0 ? sweep.rebalanceDriftPct : [base.rebalanceDriftPct],
  };
  let combos: Array<Record<SweepableField, number>> = [{} as Record<SweepableField, number>];
  for (const field of fields) {
    const next: Array<Record<SweepableField, number>> = [];
    for (const combo of combos) {
      for (const value of valueLists[field]) {
        next.push({ ...combo, [field]: value });
      }
    }
    combos = next;
  }
  return combos;
}

function makeSweepId(opts: SweepOpts): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const hash = createHash('sha256').update(JSON.stringify({
    fromMs: opts.fromMs, toMs: opts.toMs, sweep: opts.sweep, tokens: opts.tokens,
  })).digest('hex').slice(0, 8);
  return `sw-${stamp}-${hash}`;
}

export async function runSweep(opts: SweepOpts): Promise<SweepResult> {
  const startedAt = Date.now();
  const sweepId = makeSweepId(opts);
  const outDir = opts.outDir ?? DEFAULT_SWEEP_DIR;
  const sweepDir = join(outDir, sweepId);

  // Build tokenSplit (explicit or equal-weight)
  let tokenSplit: Record<string, number>;
  if (opts.tokenSplit) {
    tokenSplit = opts.tokenSplit;
  } else {
    const weight = 1 / opts.tokens.length;
    tokenSplit = {};
    for (const t of opts.tokens) tokenSplit[t] = weight;
  }

  // Base config
  const base: GridConfig = {
    ...DEFAULT_GRID_CONFIG,
    ...opts.baseConfig,
    tokens: opts.tokens,
    tokenSplit,
  };

  const combos = expandSweep(opts.sweep, base);
  if (combos.length === 0) throw new Error('sweep produced no combinations');

  // Share one loader (shared cache)
  const loader = new HistoricalDataLoader({ noCache: opts.noCache });

  if (opts.verbose !== false) {
    process.stderr.write(`  [sweep] ${sweepId}: running ${combos.length} backtests…\n`);
  }

  await mkdir(sweepDir, { recursive: true });

  const runs: SweepRunSummary[] = [];
  for (let i = 0; i < combos.length; i++) {
    const combo = combos[i]!;
    const config: GridConfig = { ...base, ...combo };
    const runOutPath = join(sweepDir, `run-${i.toString().padStart(3, '0')}.json`);

    if (opts.verbose !== false) {
      process.stderr.write(`  [sweep] [${i + 1}/${combos.length}] ${JSON.stringify(combo)}\n`);
    }

    const result: BacktestResult = await runBacktest({
      fromMs: opts.fromMs,
      toMs: opts.toMs,
      capital: opts.capital,
      config,
      loader,
      noCache: opts.noCache,
      feeBps: opts.feeBps,
      outPath: runOutPath,
    });

    const ddPct = Math.abs(result.drawdown.maxPct * 100);
    const pnlPct = result.capital.pnlPct * 100;
    const riskAdjusted = pnlPct / Math.max(ddPct, 1);
    const survived = result.liquidations.haltedAt === null;

    runs.push({
      index: i,
      config: combo,
      runId: result.runId,
      resultPath: runOutPath,
      capital: result.capital,
      fees: { bps: result.fees.bps, totalUsd: result.fees.totalUsd },
      totals: {
        roundTrips: result.totals.roundTrips,
        fills: result.totals.fills,
        pausedSteps: result.totals.pausedSteps,
      },
      drawdown: result.drawdown,
      riskAdjusted,
      survived,
      durationMs: result.durationMs,
    });
  }

  runs.sort((a, b) => {
    // Survivors first
    if (a.survived !== b.survived) return a.survived ? -1 : 1;
    // Then by risk-adjusted desc
    return b.riskAdjusted - a.riskAdjusted;
  });

  const finishedAt = Date.now();
  const sweep: SweepResult = {
    sweepId,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    window: {
      fromMs: opts.fromMs,
      toMs: opts.toMs,
      days: (opts.toMs - opts.fromMs) / (24 * 60 * 60 * 1000),
    },
    tokens: opts.tokens,
    capital: opts.capital,
    feeBps: opts.feeBps ?? 5,
    runs,
  };

  const sweepJsonPath = join(sweepDir, 'sweep.json');
  await writeFile(sweepJsonPath, JSON.stringify(sweep, null, 2), 'utf-8');

  return sweep;
}
