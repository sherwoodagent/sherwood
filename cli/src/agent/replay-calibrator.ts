/**
 * Replay calibrator — sweeps weight profiles × thresholds against
 * `signal-history.jsonl` (production captures) instead of recomputing
 * signals from candles.
 *
 * Why this exists: the candle-only `Backtester` cannot replay the
 * production signal stack. Strategies like `fundingRate`, `dexFlow`,
 * `hyperliquidFlow`, and Nansen-sourced `smartMoney` need live HL/DEX
 * data feeds that aren't in OHLC. `signal-history.jsonl` already
 * captured those signal values per scan — replaying through the scoring
 * math (which IS pure) gives a true-to-production calibration.
 *
 * Caveat: PnL accuracy is bounded by the scan cadence. If the scanner
 * fired every ~30min on a token, exit prices used for stop/TP detection
 * are sampled at the same interval. Intra-bar wicks are missed. Sharpe
 * computed from these results is a lower bound on what a tighter exit
 * loop would achieve.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { computeTradeDecision } from './scoring.js';
import type { ScoringWeights, Signal, TradeDecision } from './scoring.js';
import type { MarketRegime } from './regime.js';
import {
  WEIGHT_PROFILES,
  BUY_THRESHOLDS,
  SELL_THRESHOLDS,
  type CalibrationConfig,
  type CalibrationResult,
  type TokenResult,
} from './calibrator.js';

// ── Types ──

/** A single row from signal-history.jsonl — matches SignalLogEntry. */
interface SignalHistoryRow {
  timestamp: string;
  tokenId: string;
  tokenSymbol: string;
  price: number;
  decision: 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
  score: number;
  confidence: number;
  signals: Array<{ name: string; value: number; confidence: number }>;
  regime: string;
  btcCorrelation: number;
  weights: ScoringWeights;
}

export interface ReplayCalibratorOptions {
  /** Path to signal-history.jsonl. Defaults to ~/.sherwood/agent/signal-history.jsonl. */
  historyPath?: string;
  /** Initial capital per token (informational — we track returns, not capital). */
  capital?: number;
  /** Filter to specific tokens; defaults to all tokens in the dataset. */
  tokens?: string[];
  /** Only replay rows captured within the last N days. Useful after a scoring
   *  change to avoid contaminating calibration with stale signal values from
   *  the prior code path. Default: replay all rows in the file. */
  lastDays?: number;
  onProgress?: (msg: string) => void;
  /** Whether to honor the regime field on each row when applying thresholds.
   *  Defaults to true — rows record the regime that gated the original
   *  decision, replaying with the same regime preserves real-world behavior. */
  useRegime?: boolean;
}

// ── Exit logic constants — match backtest.ts and executor.ts ──

const STOP_LOSS_PCT = 0.03;     // 3% hard stop
const TAKE_PROFIT_PCT = 0.06;   // 6% TP (2:1 R:R)
const TRAIL_PCT = 0.025;        // 2.5% trailing stop
const TIME_STOP_HOURS = 48;     // 48h stale-trade exit

/** Open position state for replay. Mirrors the `position` struct in backtest.ts. */
interface ReplayPosition {
  side: 'long' | 'short';
  entryPrice: number;
  entryTimestamp: number;
  /** High-water mark for longs, low-water mark for shorts. */
  extremePrice: number;
  signal: string;
}

/**
 * Trade record kept inline during replay so we can compute realistic
 * Sharpe annualization from actual trade cadence rather than guessing.
 */
interface ReplayTrade {
  pnlPercent: number;
  durationMs: number;
}

// ── Loader ──

/** Read signal-history.jsonl into typed rows. Skips malformed lines. */
export async function loadSignalHistory(path: string): Promise<SignalHistoryRow[]> {
  const raw = await readFile(path, 'utf-8');
  const rows: SignalHistoryRow[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as SignalHistoryRow);
    } catch {
      // Skip malformed lines silently — log file may have been mid-write
    }
  }
  return rows;
}

/** Group rows by tokenId, sorted chronologically within each group. */
function groupByToken(rows: SignalHistoryRow[]): Map<string, SignalHistoryRow[]> {
  const grouped = new Map<string, SignalHistoryRow[]>();
  for (const r of rows) {
    if (!grouped.has(r.tokenId)) grouped.set(r.tokenId, []);
    grouped.get(r.tokenId)!.push(r);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  }
  return grouped;
}

// ── Per-token replay ──

/**
 * Replay a single token's signal history through one config.
 * Returns {trades, returns, totalReturn, sharpe, maxDrawdown, winRate}.
 */
function replayToken(
  tokenRows: SignalHistoryRow[],
  config: CalibrationConfig,
  useRegime: boolean,
): TokenResult {
  let position: ReplayPosition | null = null;
  const returns: number[] = [];
  const trades: ReplayTrade[] = []; // hold-duration tracked for Sharpe annualization
  const equityCurve: number[] = [1.0]; // normalized; multiply by (1+ret) per realized trade
  let equity = 1.0;

  for (let i = 0; i < tokenRows.length; i++) {
    const row = tokenRows[i]!;
    const ts = Date.parse(row.timestamp);
    const price = row.price;

    // Guard: rows with missing/zero/non-finite prices appear in early
    // production captures before the price feed was wired. Skip them
    // entirely — both entry and exit math would produce NaN and poison
    // the equity curve. We do NOT close any open position here; we wait
    // for the next valid price tick.
    if (!Number.isFinite(price) || price <= 0) continue;

    // Build Signal[] from row — mirrors what computeTradeDecision expects.
    // Source/details aren't needed for scoring; pass empty strings.
    const signals: Signal[] = row.signals.map((s) => ({
      name: s.name,
      value: s.value,
      confidence: s.confidence,
      source: '',
      details: '',
    }));

    const regime = useRegime
      ? (row.regime && row.regime !== 'unknown' ? (row.regime as MarketRegime) : undefined)
      : undefined;

    let decision: TradeDecision = computeTradeDecision(
      signals,
      config.weights,
      undefined,
      undefined,
      regime,
    );

    // Override action based on calibrator's threshold sweep — same logic as backtest.ts
    const buy = config.buyThreshold;
    const sell = config.sellThreshold;
    if (buy <= sell) continue; // invalid — caller should have filtered, but be safe
    const strongBuy = buy + 0.3;
    const strongSell = sell - 0.3;
    let action: TradeDecision['action'];
    if (decision.score >= strongBuy) action = 'STRONG_BUY';
    else if (decision.score >= buy) action = 'BUY';
    else if (decision.score <= strongSell) action = 'STRONG_SELL';
    else if (decision.score <= sell) action = 'SELL';
    else action = 'HOLD';
    decision = { ...decision, action };

    // ── Position management — exit conditions first, then optional entry ──
    if (position) {
      const isShort = position.side === 'short';
      // Track best favorable price
      if (isShort) {
        if (price < position.extremePrice) position.extremePrice = price;
      } else {
        if (price > position.extremePrice) position.extremePrice = price;
      }

      const pnlPercent = isShort
        ? (position.entryPrice - price) / position.entryPrice
        : (price - position.entryPrice) / position.entryPrice;
      const holdingHours = (ts - position.entryTimestamp) / (1000 * 60 * 60);

      let exitReason: string | null = null;
      if (pnlPercent <= -STOP_LOSS_PCT) exitReason = 'STOP';
      else if (pnlPercent >= TAKE_PROFIT_PCT) exitReason = 'TP';
      else if (TRAIL_PCT > 0 && (isShort
        ? price >= position.extremePrice * (1 + TRAIL_PCT)
        : price <= position.extremePrice * (1 - TRAIL_PCT))) {
        exitReason = 'TRAIL';
      } else if (holdingHours > TIME_STOP_HOURS && Math.abs(pnlPercent) < 0.01) {
        exitReason = 'TIME';
      } else if (isShort
        ? (action === 'BUY' || action === 'STRONG_BUY')
        : (action === 'SELL' || action === 'STRONG_SELL')) {
        exitReason = 'FLIP';
      }

      if (exitReason) {
        equity *= 1 + pnlPercent;
        equityCurve.push(equity);
        returns.push(pnlPercent);
        trades.push({ pnlPercent, durationMs: ts - position.entryTimestamp });
        position = null;
      }
    }

    // Entries only when flat
    if (!position) {
      if (action === 'BUY' || action === 'STRONG_BUY') {
        position = { side: 'long', entryPrice: price, entryTimestamp: ts, extremePrice: price, signal: action };
      } else if (action === 'SELL' || action === 'STRONG_SELL') {
        position = { side: 'short', entryPrice: price, entryTimestamp: ts, extremePrice: price, signal: action };
      }
    }
  }

  // Close any open position at the last VALID observed price.
  // Walking back ensures we don't close on a zero-price row.
  if (position) {
    let lastValidPrice: number | null = null;
    for (let i = tokenRows.length - 1; i >= 0; i--) {
      const p = tokenRows[i]!.price;
      if (Number.isFinite(p) && p > 0) { lastValidPrice = p; break; }
    }
    if (lastValidPrice !== null) {
      const pnlPercent = position.side === 'short'
        ? (position.entryPrice - lastValidPrice) / position.entryPrice
        : (lastValidPrice - position.entryPrice) / position.entryPrice;
      const lastTs = Date.parse(tokenRows[tokenRows.length - 1]!.timestamp);
      equity *= 1 + pnlPercent;
      equityCurve.push(equity);
      returns.push(pnlPercent);
      trades.push({ pnlPercent, durationMs: lastTs - position.entryTimestamp });
    }
  }

  // Metrics
  const totalReturn = equity - 1.0;
  const winRate = returns.length > 0 ? returns.filter((r) => r > 0).length / returns.length : 0;

  // Sharpe from per-trade returns, annualized using ACTUAL average hold
  // duration (not a fixed 52/year guess). Same formula as PortfolioTracker.
  let sharpeRatio = 0;
  if (returns.length > 1) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      const avgHoldDays = trades.length > 0
        ? trades.reduce((s, t) => s + t.durationMs, 0) / trades.length / (1000 * 60 * 60 * 24)
        : 1;
      const tradesPerYear = Math.max(252 / Math.max(avgHoldDays, 1), 1);
      sharpeRatio = (mean / stdDev) * Math.sqrt(tradesPerYear);
    }
  }

  // Max drawdown from equity curve
  let peak = equityCurve[0]!;
  let maxDrawdown = 0;
  for (const v of equityCurve) {
    if (v > peak) peak = v;
    const dd = (peak - v) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    tokenId: tokenRows[0]?.tokenId ?? '',
    totalReturn,
    sharpeRatio,
    maxDrawdown,
    winRate,
    numTrades: returns.length,
  };
}

// ── Public driver ──

/**
 * Sweep all WEIGHT_PROFILES × BUY_THRESHOLDS × SELL_THRESHOLDS against
 * a captured signal-history.jsonl. Returns the same CalibrationResult[]
 * shape as the candle-based calibrator so `formatCalibrationTable` works.
 */
export async function runHistoryReplay(
  options: ReplayCalibratorOptions = {},
): Promise<CalibrationResult[]> {
  const historyPath = options.historyPath ?? join(homedir(), '.sherwood', 'agent', 'signal-history.jsonl');
  const log = options.onProgress ?? (() => {});
  const useRegime = options.useRegime ?? true;

  log(`Loading ${historyPath}...`);
  let allRows = await loadSignalHistory(historyPath);
  log(`Loaded ${allRows.length} rows`);

  if (options.lastDays !== undefined && options.lastDays > 0) {
    const cutoff = Date.now() - options.lastDays * 24 * 60 * 60 * 1000;
    const before = allRows.length;
    allRows = allRows.filter((r) => Date.parse(r.timestamp) >= cutoff);
    log(`Filtered to last ${options.lastDays}d: ${allRows.length} rows (dropped ${before - allRows.length})`);
  }

  const grouped = groupByToken(allRows);
  let tokens = options.tokens ?? Array.from(grouped.keys());
  // Drop tokens with too few observations to produce meaningful trades
  const MIN_ROWS = 5;
  tokens = tokens.filter((t) => (grouped.get(t)?.length ?? 0) >= MIN_ROWS);
  log(`Replaying ${tokens.length} tokens (>=${MIN_ROWS} observations each)`);

  const configs: CalibrationConfig[] = [];
  for (const [profileName, weights] of Object.entries(WEIGHT_PROFILES)) {
    for (const buyThreshold of BUY_THRESHOLDS) {
      for (const sellThreshold of SELL_THRESHOLDS) {
        if (buyThreshold <= sellThreshold) continue; // skip invalid
        configs.push({ profileName, weights, buyThreshold, sellThreshold });
      }
    }
  }
  log(`Sweeping ${configs.length} configs across ${tokens.length} tokens`);

  const results: CalibrationResult[] = configs.map((config) => ({
    config,
    tokenResults: [],
    avgReturn: 0,
    avgSharpe: 0,
    worstDrawdown: 0,
    totalTrades: 0,
  }));

  // Replay loop — pure of network IO, runs in seconds even for 200 × 15.
  let processed = 0;
  for (const token of tokens) {
    const rows = grouped.get(token)!;
    for (let ci = 0; ci < configs.length; ci++) {
      const cfg = configs[ci]!;
      const tokenResult = replayToken(rows, cfg, useRegime);
      results[ci]!.tokenResults.push(tokenResult);
    }
    processed++;
    log(`  ${token}: ${rows.length} rows, ${configs.length} configs done (${processed}/${tokens.length})`);
  }

  // Aggregate
  for (const r of results) {
    const tr = r.tokenResults;
    if (tr.length === 0) continue;
    r.avgReturn = tr.reduce((s, x) => s + x.totalReturn, 0) / tr.length;
    r.avgSharpe = tr.reduce((s, x) => s + x.sharpeRatio, 0) / tr.length;
    r.worstDrawdown = Math.max(...tr.map((x) => x.maxDrawdown));
    r.totalTrades = tr.reduce((s, x) => s + x.numTrades, 0);
  }

  // Sort: 0-trade configs sink to bottom (same logic as candle calibrator).
  results.sort((a, b) => {
    const aZero = a.totalTrades === 0;
    const bZero = b.totalTrades === 0;
    if (aZero !== bZero) return aZero ? 1 : -1;
    if (Math.abs(b.avgSharpe - a.avgSharpe) > 0.001) return b.avgSharpe - a.avgSharpe;
    return b.avgReturn - a.avgReturn;
  });

  await saveResults(results);
  return results;
}

async function saveResults(results: CalibrationResult[]): Promise<void> {
  const dir = join(homedir(), '.sherwood', 'agent');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'replay-calibration-results.json');
  const payload = {
    timestamp: new Date().toISOString(),
    totalConfigs: results.length,
    source: 'signal-history.jsonl replay',
    results: results.map((r, i) => ({
      rank: i + 1,
      profile: r.config.profileName,
      buyThreshold: r.config.buyThreshold,
      sellThreshold: r.config.sellThreshold,
      weights: r.config.weights,
      avgReturn: r.avgReturn,
      avgSharpe: r.avgSharpe,
      worstDrawdown: r.worstDrawdown,
      totalTrades: r.totalTrades,
      tokenResults: r.tokenResults,
    })),
  };
  await writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
}
