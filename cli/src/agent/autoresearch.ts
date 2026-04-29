/**
 * Autoresearch — autonomous strategy parameter optimization.
 *
 * Inspired by Karpathy/Nunchi's autoresearch pattern: an AI agent
 * iteratively mutates strategy parameters, backtests via replay
 * calibration against production signal-history.jsonl, and retains
 * only improvements. Git history becomes the experiment log.
 *
 * Usage:
 *   sherwood agent autoresearch [--experiments N] [--last-days D]
 *
 * The mutable state is a StrategyParams object. Each experiment:
 * 1. Proposes a single parameter mutation
 * 2. Runs replay calibration with the mutated params
 * 3. Computes a composite score (Sharpe × √min(trades/20,1) - DD penalty)
 * 4. If score improves → keeps the mutation; otherwise reverts
 * 5. Logs the experiment to autoresearch-log.jsonl
 */

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import { loadSignalHistory } from './replay-calibrator.js';
import { computeTradeDecision } from './scoring.js';
import type { ScoringWeights, Signal, TradeDecision } from './scoring.js';
import type { MarketRegime } from './regime.js';

// ── Mutable parameter space ──

export interface StrategyParams {
  // Signal weights (must sum to ~1.0 across active categories)
  weights: ScoringWeights;
  // Thresholds
  buyThreshold: number;
  sellThreshold: number;
  // Exit params (in price-move terms, NOT leveraged)
  stopLossPct: number;
  takeProfitRR: number;   // R:R multiplier on stop → TP = stop * this
  trailPct: number;
  timeStopHours: number;
  /** Leverage multiplier — PnL = raw price move × leverage. */
  leverage: number;
}

const DEFAULT_PARAMS: StrategyParams = {
  weights: {
    smartMoney: 0.30,
    technical: 0.25,
    sentiment: 0.10,
    onchain: 0.20,
    fundamental: 0.15,
    event: 0.00,
  },
  buyThreshold: 0.14,     // autoresearch walk-forward validated
  sellThreshold: -0.14,
  stopLossPct: 0.05,
  takeProfitRR: 2.0,     // wider TP captures more upside
  trailPct: 0.03,       // tighter trail (from 4%)
  timeStopHours: 84,    // shorter (from 96h)
  leverage: 1,           // no leverage until WR > 60%
};

// ── Scoring ──

interface ExperimentResult {
  id: number;
  params: StrategyParams;
  score: number;
  sharpe: number;
  totalReturn: number;
  maxDrawdown: number;
  trades: number;
  winRate: number;
  mutation: string;
  improved: boolean;
  timestamp: string;
}

/**
 * Score a parameter set against signal-history data.
 * Uses the same replay logic as replay-calibrator but with custom params.
 */
function scoreParams(
  rows: SignalHistoryRow[],
  params: StrategyParams,
): { sharpe: number; totalReturn: number; maxDrawdown: number; trades: number; winRate: number; score: number } {
  // Group by token
  const grouped = new Map<string, SignalHistoryRow[]>();
  for (const r of rows) {
    if (!grouped.has(r.tokenId)) grouped.set(r.tokenId, []);
    grouped.get(r.tokenId)!.push(r);
  }

  const allReturns: number[] = [];
  const allHoldDurations: number[] = []; // ms per closed trade
  let totalTrades = 0;
  let wins = 0;

  for (const [_token, tokenRows] of grouped) {
    tokenRows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

    let position: { side: 'long' | 'short'; entryPrice: number; entryTs: number; extreme: number } | null = null;

    for (const row of tokenRows) {
      const price = row.price;
      if (!Number.isFinite(price) || price <= 0) continue;

      const signals: Signal[] = row.signals.map(s => ({
        name: s.name, value: s.value, confidence: s.confidence, source: '', details: '',
      }));

      const regime = (row.regime && row.regime !== 'unknown') ? row.regime as MarketRegime : undefined;
      const decision = computeTradeDecision(signals, params.weights, undefined, undefined, regime);

      // Apply custom thresholds
      let action: string;
      if (decision.score >= params.buyThreshold + 0.15) action = 'STRONG_BUY';
      else if (decision.score >= params.buyThreshold) action = 'BUY';
      else if (decision.score <= params.sellThreshold - 0.10) action = 'STRONG_SELL';
      else if (decision.score <= params.sellThreshold) action = 'SELL';
      else action = 'HOLD';

      const ts = Date.parse(row.timestamp);

      // Exit logic
      if (position) {
        const isShort = position.side === 'short';
        if (isShort && price < position.extreme) position.extreme = price;
        if (!isShort && price > position.extreme) position.extreme = price;

        // Raw price move (before leverage) — used for stop/TP checks
        const rawPnl = isShort
          ? (position.entryPrice - price) / position.entryPrice
          : (price - position.entryPrice) / position.entryPrice;
        // Leveraged PnL — actual return on capital
        const pnl = rawPnl * params.leverage;
        const hours = (ts - position.entryTs) / 3600000;

        // Stop/TP are in price-move terms (not leveraged)
        const tpPct = params.stopLossPct * params.takeProfitRR;
        let exit = false;
        if (rawPnl <= -params.stopLossPct) exit = true;
        else if (rawPnl >= tpPct) exit = true;
        else if (params.trailPct > 0 && (isShort
          ? price >= position.extreme * (1 + params.trailPct)
          : price <= position.extreme * (1 - params.trailPct))) exit = true;
        else if (hours > params.timeStopHours && Math.abs(pnl) < 0.01) exit = true;
        else if (isShort ? (action === 'BUY' || action === 'STRONG_BUY') : (action === 'SELL' || action === 'STRONG_SELL')) exit = true;

        if (exit) {
          allReturns.push(pnl);
          allHoldDurations.push(ts - position.entryTs);
          totalTrades++;
          if (pnl > 0) wins++;
          position = null;
        }
      }

      // Entry
      if (!position) {
        if (action === 'BUY' || action === 'STRONG_BUY') {
          position = { side: 'long', entryPrice: price, entryTs: ts, extreme: price };
        } else if (action === 'SELL' || action === 'STRONG_SELL') {
          position = { side: 'short', entryPrice: price, entryTs: ts, extreme: price };
        }
      }
    }
  }

  // Compute metrics — require minimum trades for statistical significance.
  // Lower threshold during early exploration (5 trades); raise to 20+ once
  // we have weeks of signal data under the new stack.
  if (totalTrades < 5) {
    return { sharpe: -999, totalReturn: 0, maxDrawdown: 1, trades: totalTrades, winRate: 0, score: -999 };
  }

  const mean = allReturns.reduce((s, r) => s + r, 0) / allReturns.length;
  const variance = allReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (allReturns.length - 1);
  const std = Math.sqrt(variance);

  // Hold-duration-aware Sharpe annualization (from replay-calibrator).
  // Prior code used √252 blindly, inflating Sharpe ~1.8x for multi-day holds.
  const avgHoldMs = allHoldDurations.length > 0
    ? allHoldDurations.reduce((s, d) => s + d, 0) / allHoldDurations.length
    : 86400000; // 1 day fallback
  const avgHoldDays = Math.max(avgHoldMs / 86400000, 0.1);
  const tradesPerYear = Math.max(252 / avgHoldDays, 1);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(tradesPerYear) : 0;

  const totalReturn = allReturns.reduce((eq, r) => eq * (1 + r), 1) - 1;

  // Max drawdown from equity curve
  let peak = 1;
  let equity = 1;
  let maxDD = 0;
  for (const r of allReturns) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const winRate = wins / totalTrades;

  // Composite score — penalizes low sample sizes and large drawdowns.
  // tradePenalty scales from 0 at 20 trades to 1.0 at 50 trades (was 20).
  const tradePenalty = Math.sqrt(Math.min(totalTrades / 50, 1.0));
  const ddPenalty = maxDD > 0.50 ? 999 : maxDD * 5;
  const score = sharpe * tradePenalty - ddPenalty;

  return { sharpe, totalReturn, maxDrawdown: maxDD, trades: totalTrades, winRate, score };
}

// ── Mutation engine ──

const MUTATIONS: Array<{ name: string; mutate: (p: StrategyParams) => StrategyParams }> = [
  // Weight mutations
  { name: 'boost_technical', mutate: p => ({ ...p, weights: { ...p.weights, technical: Math.min(0.50, p.weights.technical + 0.05) } }) },
  { name: 'reduce_technical', mutate: p => ({ ...p, weights: { ...p.weights, technical: Math.max(0.05, p.weights.technical - 0.05) } }) },
  { name: 'boost_onchain', mutate: p => ({ ...p, weights: { ...p.weights, onchain: Math.min(0.50, p.weights.onchain + 0.05) } }) },
  { name: 'reduce_onchain', mutate: p => ({ ...p, weights: { ...p.weights, onchain: Math.max(0.0, p.weights.onchain - 0.05) } }) },
  { name: 'boost_sentiment', mutate: p => ({ ...p, weights: { ...p.weights, sentiment: Math.min(0.40, p.weights.sentiment + 0.05) } }) },
  { name: 'reduce_sentiment', mutate: p => ({ ...p, weights: { ...p.weights, sentiment: Math.max(0.0, p.weights.sentiment - 0.05) } }) },
  { name: 'zero_fundamental', mutate: p => ({ ...p, weights: { ...p.weights, fundamental: 0 } }) },
  { name: 'restore_fundamental', mutate: p => ({ ...p, weights: { ...p.weights, fundamental: 0.05 } }) },

  // Threshold mutations
  { name: 'lower_buy_threshold', mutate: p => ({ ...p, buyThreshold: Math.max(0.05, p.buyThreshold - 0.02) }) },
  { name: 'raise_buy_threshold', mutate: p => ({ ...p, buyThreshold: Math.min(0.40, p.buyThreshold + 0.02) }) },
  { name: 'tighten_sell_threshold', mutate: p => ({ ...p, sellThreshold: Math.min(-0.05, p.sellThreshold + 0.02) }) },
  { name: 'loosen_sell_threshold', mutate: p => ({ ...p, sellThreshold: Math.max(-0.50, p.sellThreshold - 0.02) }) },

  // Stop/exit mutations
  { name: 'widen_stop', mutate: p => ({ ...p, stopLossPct: Math.min(0.15, p.stopLossPct + 0.01) }) },
  { name: 'tighten_stop', mutate: p => ({ ...p, stopLossPct: Math.max(0.02, p.stopLossPct - 0.01) }) },
  { name: 'increase_rr', mutate: p => ({ ...p, takeProfitRR: Math.min(4.0, p.takeProfitRR + 0.5) }) },
  { name: 'decrease_rr', mutate: p => ({ ...p, takeProfitRR: Math.max(1.0, p.takeProfitRR - 0.5) }) },
  { name: 'widen_trail', mutate: p => ({ ...p, trailPct: Math.min(0.10, p.trailPct + 0.01) }) },
  { name: 'tighten_trail', mutate: p => ({ ...p, trailPct: Math.max(0.01, p.trailPct - 0.01) }) },
  { name: 'longer_time_stop', mutate: p => ({ ...p, timeStopHours: Math.min(96, p.timeStopHours + 12) }) },
  { name: 'shorter_time_stop', mutate: p => ({ ...p, timeStopHours: Math.max(12, p.timeStopHours - 12) }) },
  { name: 'disable_time_stop', mutate: p => ({ ...p, timeStopHours: 999 }) },

  // Leverage mutations
  { name: 'increase_leverage', mutate: p => ({ ...p, leverage: Math.min(5, p.leverage + 1) }) },
  { name: 'decrease_leverage', mutate: p => ({ ...p, leverage: Math.max(1, p.leverage - 1) }) },

  // Fundamental/event weight mutations (newly active categories)
  { name: 'boost_fundamental', mutate: p => ({ ...p, weights: { ...p.weights, fundamental: Math.min(0.30, p.weights.fundamental + 0.05) } }) },
  { name: 'boost_event', mutate: p => ({ ...p, weights: { ...p.weights, event: Math.min(0.25, p.weights.event + 0.05) } }) },
  { name: 'reduce_event', mutate: p => ({ ...p, weights: { ...p.weights, event: Math.max(0.0, p.weights.event - 0.05) } }) },
];

// ── Signal history row type (matches signal-logger output) ──

interface SignalHistoryRow {
  timestamp: string;
  tokenId: string;
  tokenSymbol?: string;
  price: number;
  decision: string;
  score: number;
  confidence: number;
  signals: Array<{ name: string; value: number; confidence: number }>;
  regime?: string;
  weights?: Record<string, number>;
}

// ── Main loop ──

export interface AutoresearchOptions {
  experiments?: number;
  lastDays?: number;
  historyPaths?: string[];
}

export async function runAutoresearch(opts: AutoresearchOptions): Promise<void> {
  const base = join(homedir(), '.sherwood', 'agent');
  const logPath = join(base, 'autoresearch-log.jsonl');

  // Load signal history (combine rotated + current)
  const paths = opts.historyPaths ?? [
    join(base, 'signal-history-2026-04-21.jsonl'),
    join(base, 'signal-history.jsonl'),
  ];

  let allRows: SignalHistoryRow[] = [];
  for (const p of paths) {
    try {
      const raw = await readFile(p, 'utf-8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { allRows.push(JSON.parse(line) as SignalHistoryRow); } catch { /* skip */ }
      }
    } catch { /* file missing */ }
  }

  // Filter by lastDays
  if (opts.lastDays) {
    const cutoff = Date.now() - opts.lastDays * 86400000;
    allRows = allRows.filter(r => Date.parse(r.timestamp) >= cutoff);
  }

  console.log(chalk.bold(`\n  Autoresearch — ${allRows.length} signal rows loaded`));

  if (allRows.length < 100) {
    console.log(chalk.red('  Insufficient data for autoresearch (need 100+ rows). Aborting.'));
    return;
  }

  const maxExperiments = opts.experiments ?? 50;
  let currentParams = { ...DEFAULT_PARAMS };

  // Score baseline
  const baseline = scoreParams(allRows, currentParams);
  let bestScore = baseline.score;
  console.log(chalk.dim(`  Baseline: score=${baseline.score.toFixed(3)} sharpe=${baseline.sharpe.toFixed(2)} trades=${baseline.trades} WR=${(baseline.winRate*100).toFixed(0)}% DD=${(baseline.maxDrawdown*100).toFixed(1)}%`));
  console.log(chalk.dim(`  Running ${maxExperiments} experiments...\n`));

  let improvements = 0;

  for (let exp = 1; exp <= maxExperiments; exp++) {
    // Pick a random mutation
    const mutation = MUTATIONS[Math.floor(Math.random() * MUTATIONS.length)]!;
    const mutatedParams = mutation.mutate(currentParams);

    // Score
    const result = scoreParams(allRows, mutatedParams);
    const improved = result.score > bestScore;

    if (improved) {
      currentParams = mutatedParams;
      bestScore = result.score;
      improvements++;
      console.log(chalk.green(
        `  #${exp} ${mutation.name}: score ${result.score.toFixed(3)} (${improved ? '+' : ''}${(result.score - baseline.score).toFixed(3)}) ` +
        `sharpe=${result.sharpe.toFixed(2)} trades=${result.trades} WR=${(result.winRate*100).toFixed(0)}% DD=${(result.maxDrawdown*100).toFixed(1)}% ✓`
      ));
    } else {
      // Revert — currentParams stays the same
      if (exp % 10 === 0) {
        console.log(chalk.dim(`  #${exp} ${mutation.name}: score ${result.score.toFixed(3)} — no improvement (best=${bestScore.toFixed(3)})`));
      }
    }

    // Log experiment
    const logEntry: ExperimentResult = {
      id: exp,
      params: improved ? mutatedParams : currentParams,
      score: result.score,
      sharpe: result.sharpe,
      totalReturn: result.totalReturn,
      maxDrawdown: result.maxDrawdown,
      trades: result.trades,
      winRate: result.winRate,
      mutation: mutation.name,
      improved,
      timestamp: new Date().toISOString(),
    };
    await appendFile(logPath, JSON.stringify(logEntry) + '\n');
  }

  // Walk-forward validation: score optimized params on held-out data.
  // Split all rows by timestamp: first 70% = train (used above), last 30% = test.
  const sorted = [...allRows].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const splitIdx = Math.floor(sorted.length * 0.7);
  const testRows = sorted.slice(splitIdx);
  const trainResult = scoreParams(sorted.slice(0, splitIdx), currentParams);
  const testResult = scoreParams(testRows, currentParams);
  const baselineTest = scoreParams(testRows, DEFAULT_PARAMS);

  // Final results
  const final = scoreParams(allRows, currentParams);
  console.log(chalk.bold(`\n  ═══════════════════════════════════════`));
  console.log(chalk.bold(`  Autoresearch complete: ${maxExperiments} experiments, ${improvements} improvements`));
  console.log(chalk.bold(`  ═══════════════════════════════════════`));
  console.log(`  Baseline score: ${baseline.score.toFixed(3)} → Final: ${final.score.toFixed(3)}`);
  console.log(`  Sharpe: ${baseline.sharpe.toFixed(2)} → ${final.sharpe.toFixed(2)}`);
  console.log(`  Trades: ${baseline.trades} → ${final.trades}`);
  console.log(`  Win rate: ${(baseline.winRate*100).toFixed(0)}% → ${(final.winRate*100).toFixed(0)}%`);
  console.log(`  Max DD: ${(baseline.maxDrawdown*100).toFixed(1)}% → ${(final.maxDrawdown*100).toFixed(1)}%`);

  // Walk-forward report
  console.log(chalk.bold(`\n  ── Walk-Forward Validation (last 30% of data) ──`));
  console.log(`  Test rows: ${testRows.length} (${(testRows.length / allRows.length * 100).toFixed(0)}% of total)`);
  if (testResult.trades >= 5) {
    console.log(`  Baseline on test: sharpe=${baselineTest.sharpe.toFixed(2)} trades=${baselineTest.trades} WR=${(baselineTest.winRate*100).toFixed(0)}%`);
    console.log(`  Optimized on test: sharpe=${testResult.sharpe.toFixed(2)} trades=${testResult.trades} WR=${(testResult.winRate*100).toFixed(0)}%`);
    const testImproved = testResult.score > baselineTest.score;
    console.log(testImproved
      ? chalk.green(`  ✓ Params validated — improved on held-out data`)
      : chalk.yellow(`  ⚠ Params may be overfit — degraded on held-out data`));
  } else {
    console.log(chalk.yellow(`  ⚠ Insufficient test trades (${testResult.trades}) for validation — use more data`));
  }
  console.log(`\n  Best params:`);
  console.log(`    weights: tech=${currentParams.weights.technical} sent=${currentParams.weights.sentiment} onchain=${currentParams.weights.onchain} fund=${currentParams.weights.fundamental}`);
  console.log(`    buyThreshold: ${currentParams.buyThreshold}  sellThreshold: ${currentParams.sellThreshold}`);
  console.log(`    stop: ${(currentParams.stopLossPct*100).toFixed(0)}%  RR: ${currentParams.takeProfitRR}  trail: ${(currentParams.trailPct*100).toFixed(0)}%  timeStop: ${currentParams.timeStopHours}h`);
  console.log(`\n  Log: ${logPath}`);

  // Save best params
  const bestPath = join(base, 'autoresearch-best-params.json');
  await writeFile(bestPath, JSON.stringify({ ...currentParams, _score: final.score, _sharpe: final.sharpe, _experiments: maxExperiments }, null, 2));
  console.log(`  Best params saved: ${bestPath}\n`);
}
