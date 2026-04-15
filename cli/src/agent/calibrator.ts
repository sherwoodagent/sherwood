/**
 * Multi-token scoring calibration backtester.
 * Fetches data ONCE per token, then replays with different weight/threshold combos.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { Backtester } from "./backtest.js";
import type { ScoringWeights } from "./scoring.js";
import type { Candle } from "./technical.js";

// ── Weight Profiles ──
//
// IMPORTANT: this set deliberately includes BOTH the live production
// profiles (default-live, majors-live, altcoin-live — pulled from
// scoring.ts WEIGHT_PROFILES) AND exploratory profiles for tuning.
// Without the live profiles in the sweep, the calibrator can never tell
// you "the current production weights are the best" — you'd only see
// rankings of variants. The live entries are SUFFIXED `-live` so they're
// obvious in the ranked output.
//
// To keep this in sync after a scoring.ts weight change: update the
// `*-live` rows below to match the new production weights.

export const WEIGHT_PROFILES: Record<string, ScoringWeights> = {
  // ── Live production profiles (from scoring.ts; keep in sync) ──
  "default-live": { smartMoney: 0.15, technical: 0.10, sentiment: 0.40, onchain: 0.20, fundamental: 0.10, event: 0.05 },
  "majors-live":  { smartMoney: 0.15, technical: 0.10, sentiment: 0.40, onchain: 0.35, fundamental: 0.00, event: 0.00 },
  "altcoin-live": { smartMoney: 0.15, technical: 0.15, sentiment: 0.30, onchain: 0.20, fundamental: 0.10, event: 0.10 },

  // ── Exploratory profiles (historical baselines + variants) ──
  default:    { smartMoney: 0.25, technical: 0.20, sentiment: 0.20, onchain: 0.15, fundamental: 0.10, event: 0.10 },
  techHeavy:  { smartMoney: 0.10, technical: 0.40, sentiment: 0.15, onchain: 0.15, fundamental: 0.10, event: 0.10 },
  sentHeavy:  { smartMoney: 0.10, technical: 0.15, sentiment: 0.40, onchain: 0.15, fundamental: 0.10, event: 0.10 },
  onchainHvy: { smartMoney: 0.10, technical: 0.20, sentiment: 0.15, onchain: 0.35, fundamental: 0.10, event: 0.10 },
  balanced:   { smartMoney: 0.17, technical: 0.17, sentiment: 0.17, onchain: 0.17, fundamental: 0.16, event: 0.16 },
  momentum:   { smartMoney: 0.15, technical: 0.35, sentiment: 0.10, onchain: 0.25, fundamental: 0.10, event: 0.05 },
  contrarian: { smartMoney: 0.10, technical: 0.10, sentiment: 0.40, onchain: 0.10, fundamental: 0.15, event: 0.15 },
  flowBased:  { smartMoney: 0.20, technical: 0.15, sentiment: 0.10, onchain: 0.35, fundamental: 0.10, event: 0.10 },
};

// Added 0.25 / -0.25 so the calibrator can validate the lowered ranging-regime
// BUY threshold against historical data. Grid is now 8 profiles × 5 × 5 = 200.
export const BUY_THRESHOLDS = [0.2, 0.25, 0.3, 0.4, 0.5];
export const SELL_THRESHOLDS = [-0.2, -0.25, -0.3, -0.4, -0.5];

export const DEFAULT_CALIBRATION_TOKENS = [
  "bitcoin", "ethereum", "solana", "aave", "uniswap", "chainlink", "arbitrum",
];

// ── Types ──

export interface CalibrationConfig {
  profileName: string;
  weights: ScoringWeights;
  buyThreshold: number;
  sellThreshold: number;
}

export interface TokenResult {
  tokenId: string;
  totalReturn: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  numTrades: number;
}

export interface CalibrationResult {
  config: CalibrationConfig;
  tokenResults: TokenResult[];
  avgReturn: number;
  avgSharpe: number;
  worstDrawdown: number;
  totalTrades: number;
}

export interface CalibratorOptions {
  tokens: string[];
  days: number;
  capital: number;
  onProgress?: (msg: string) => void;
}

// ── Build the configuration grid ──

export function buildCalibrationConfigs(): CalibrationConfig[] {
  const configs: CalibrationConfig[] = [];

  for (const [profileName, weights] of Object.entries(WEIGHT_PROFILES)) {
    for (const buyThreshold of BUY_THRESHOLDS) {
      for (const sellThreshold of SELL_THRESHOLDS) {
        configs.push({ profileName, weights, buyThreshold, sellThreshold });
      }
    }
  }

  return configs;
}

// ── Calibrator ──

export async function runCalibration(opts: CalibratorOptions): Promise<CalibrationResult[]> {
  const { tokens, days, capital, onProgress } = opts;
  const configs = buildCalibrationConfigs();
  const log = onProgress ?? (() => {});

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days);

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  // Map: configKey -> CalibrationResult
  const resultMap = new Map<string, CalibrationResult>();
  for (const cfg of configs) {
    const key = configKey(cfg);
    resultMap.set(key, {
      config: cfg,
      tokenResults: [],
      avgReturn: 0,
      avgSharpe: 0,
      worstDrawdown: 0,
      totalTrades: 0,
    });
  }

  // Process tokens SEQUENTIALLY — fetch data ONCE per token, then replay all configs
  for (let ti = 0; ti < tokens.length; ti++) {
    const tokenId = tokens[ti]!;
    log(`[${ti + 1}/${tokens.length}] Fetching data for ${tokenId}...`);

    // Fetch data once using a baseline backtester
    const baseBt = new Backtester({
      tokenId,
      startDate: startStr,
      endDate: endStr,
      initialCapital: capital,
      strategies: [],
      cycle: "1d",
      verbose: false,
    });

    let candles: Candle[];
    let fearAndGreedData: Record<string, number>;
    try {
      const data = await baseBt.fetchData();
      candles = data.candles;
      fearAndGreedData = data.fearAndGreedData;
      log(`  Got ${candles.length} candles + ${Object.keys(fearAndGreedData).length} F&G points`);
    } catch (err) {
      log(`  SKIP ${tokenId}: ${(err as Error).message}`);
      // Record zeros for all configs
      for (const cfg of configs) {
        const key = configKey(cfg);
        resultMap.get(key)!.tokenResults.push({
          tokenId, totalReturn: 0, sharpeRatio: 0, maxDrawdown: 0, winRate: 0, numTrades: 0,
        });
      }
      continue;
    }

    // Pre-compute strategy signals + regime ONCE per candle (this is the
    // network-bound work — most strategies hit their own APIs). Each subsequent
    // simulate() call replays only the scoring math against these cached
    // signals, turning a multi-hour calibration into seconds.
    log(`  Precomputing signals for ${candles.length} candles...`);
    let precomputed: Awaited<ReturnType<Backtester['precomputeSignals']>>;
    try {
      precomputed = await baseBt.precomputeSignals(candles, fearAndGreedData);
      const valid = precomputed.filter((p) => p !== null).length;
      log(`  Precomputed ${valid} candle signal sets`);
    } catch (err) {
      log(`  SKIP ${tokenId}: precompute failed: ${(err as Error).message}`);
      for (const cfg of configs) {
        const key = configKey(cfg);
        resultMap.get(key)!.tokenResults.push({
          tokenId, totalReturn: 0, sharpeRatio: 0, maxDrawdown: 0, winRate: 0, numTrades: 0,
        });
      }
      continue;
    }

    // Now replay all configs using cached signals (zero API calls!)
    log(`  Running ${configs.length} configs on ${tokenId}...`);
    for (let ci = 0; ci < configs.length; ci++) {
      const cfg = configs[ci]!;
      const key = configKey(cfg);

      try {
        const bt = new Backtester({
          tokenId,
          startDate: startStr,
          endDate: endStr,
          initialCapital: capital,
          strategies: [],
          cycle: "1d",
          verbose: false,
          customWeights: cfg.weights,
          buyThreshold: cfg.buyThreshold,
          sellThreshold: cfg.sellThreshold,
        });

        // Use simulate() with precomputed signals — pure of network IO
        const result = await bt.simulate(candles, fearAndGreedData, precomputed);

        resultMap.get(key)!.tokenResults.push({
          tokenId,
          totalReturn: result.totalReturnPercent,
          sharpeRatio: result.sharpeRatio,
          maxDrawdown: result.maxDrawdown,
          winRate: result.winRate,
          numTrades: result.totalTrades,
        });
      } catch {
        resultMap.get(key)!.tokenResults.push({
          tokenId, totalReturn: 0, sharpeRatio: 0, maxDrawdown: 0, winRate: 0, numTrades: 0,
        });
      }

      if ((ci + 1) % 50 === 0) {
        log(`  ${tokenId}: ${ci + 1}/${configs.length} configs done`);
      }
    }

    log(`  ${tokenId} complete`);

    // Rate limit pause between tokens
    if (ti < tokens.length - 1) {
      log(`  Pausing 5s for CoinGecko rate limits...`);
      await sleep(5000);
    }
  }

  // Aggregate results
  const results: CalibrationResult[] = [];
  for (const entry of resultMap.values()) {
    const tr = entry.tokenResults;
    if (tr.length === 0) continue;

    entry.avgReturn = tr.reduce((s, r) => s + r.totalReturn, 0) / tr.length;
    entry.avgSharpe = tr.reduce((s, r) => s + r.sharpeRatio, 0) / tr.length;
    entry.worstDrawdown = Math.max(...tr.map(r => r.maxDrawdown));
    entry.totalTrades = tr.reduce((s, r) => s + r.numTrades, 0);
    results.push(entry);
  }

  // Sort: 0-trade configs sink to the bottom (vacuously "safe" — sharpe=0
  // ties at the top otherwise, masking real winners). Among configs that
  // actually trade, sort by avgSharpe desc, then avgReturn desc.
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

// ── Helpers ──

function configKey(cfg: CalibrationConfig): string {
  return `${cfg.profileName}|buy=${cfg.buyThreshold}|sell=${cfg.sellThreshold}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveResults(results: CalibrationResult[]): Promise<void> {
  const dir = join(homedir(), ".sherwood", "agent");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "calibration-results.json");
  const payload = {
    timestamp: new Date().toISOString(),
    totalConfigs: results.length,
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
  await writeFile(path, JSON.stringify(payload, null, 2), "utf-8");
}

// ── Format Results Table ──

export function formatCalibrationTable(results: CalibrationResult[], topN = 20): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("  Calibration Results (ranked by Sharpe ratio)");
  lines.push("  " + "=".repeat(110));
  lines.push(
    "  " +
    "Rank".padEnd(6) +
    "Profile".padEnd(13) +
    "Buy".padEnd(7) +
    "Sell".padEnd(7) +
    "Avg Return".padEnd(13) +
    "Avg Sharpe".padEnd(13) +
    "Worst DD".padEnd(11) +
    "Trades".padEnd(9) +
    "Tokens"
  );
  lines.push("  " + "-".repeat(110));

  const top = results.slice(0, topN);
  for (let i = 0; i < top.length; i++) {
    const r = top[i]!;
    const rank = String(i + 1).padEnd(6);
    const profile = r.config.profileName.padEnd(13);
    const buy = String(r.config.buyThreshold).padEnd(7);
    const sell = String(r.config.sellThreshold).padEnd(7);
    const avgRet = (r.avgReturn.toFixed(2) + "%").padEnd(13);
    const avgSharpe = r.avgSharpe.toFixed(3).padEnd(13);
    const worstDD = (r.worstDrawdown.toFixed(2) + "%").padEnd(11);
    const trades = String(r.totalTrades).padEnd(9);
    const tokenCount = String(r.tokenResults.length);

    lines.push("  " + rank + profile + buy + sell + avgRet + avgSharpe + worstDD + trades + tokenCount);
  }

  lines.push("  " + "-".repeat(110));

  if (results.length > 0) {
    const best = results[0]!;
    lines.push("");
    lines.push("  BEST CONFIGURATION:");
    lines.push(`    Profile:        ${best.config.profileName}`);
    lines.push(`    Buy threshold:  ${best.config.buyThreshold}`);
    lines.push(`    Sell threshold: ${best.config.sellThreshold}`);
    lines.push(`    Weights:        smartMoney=${best.config.weights.smartMoney} technical=${best.config.weights.technical} sentiment=${best.config.weights.sentiment} onchain=${best.config.weights.onchain} fundamental=${best.config.weights.fundamental} event=${best.config.weights.event}`);
    lines.push(`    Avg return:     ${best.avgReturn.toFixed(2)}%`);
    lines.push(`    Avg Sharpe:     ${best.avgSharpe.toFixed(3)}`);
    lines.push(`    Worst drawdown: ${best.worstDrawdown.toFixed(2)}%`);

    // Show per-token breakdown for best config
    lines.push("");
    lines.push("  Per-token breakdown (best config):");
    for (const tr of best.tokenResults) {
      lines.push(`    ${tr.tokenId.padEnd(12)} return: ${tr.totalReturn.toFixed(2).padStart(8)}%  sharpe: ${tr.sharpeRatio.toFixed(3).padStart(7)}  trades: ${tr.numTrades}`);
    }
  }

  lines.push("");
  const savePath = join(homedir(), ".sherwood", "agent", "calibration-results.json");
  lines.push(`  Full results saved to ${savePath}`);
  lines.push("");

  return lines.join("\n");
}
