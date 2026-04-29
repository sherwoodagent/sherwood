/**
 * Kronos volatility forecaster via Python subprocess.
 *
 * Runs the Kronos-mini foundation model (4.1M params) on CPU to predict
 * N future price paths from OHLCV candles, then computes volatility metrics
 * from the path spread.
 *
 * Latency: ~2.3s for 5 paths on CPU (tested on 2-core VPS).
 * Memory: ~350MB peak (model + PyTorch).
 * Cache: 1 hour (vol forecasts don't need per-cycle updates).
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { FINCEPT_SCRIPTS_DIR } from "./bridge.js";
import type { Candle } from "../../agent/technical.js";

/** Kronos needs PyTorch — use the dedicated venv if it exists,
 *  otherwise fall back to system python3. */
const KRONOS_VENV_PYTHON = join(process.env.HOME ?? "/home/ana", ".sherwood", "kronos-venv", "bin", "python3");
const KRONOS_PYTHON = existsSync(KRONOS_VENV_PYTHON) ? KRONOS_VENV_PYTHON : "python3";

const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const TIMEOUT_MS = 30_000;

export interface KronosVolForecast {
  /** Annualized volatility from Monte Carlo path spread. */
  predictedVolatility: number;
  /** Per-candle (4h) volatility as a fraction. */
  predictedVol4h: number;
  /** Directional bias from mean path: -1 (bearish) to +1 (bullish). */
  directionalBias: number;
  /** % spread between worst and best path at prediction horizon. */
  pathSpreadPct: number;
  /** Number of candles predicted. */
  predictionHorizon: number;
  /** Number of Monte Carlo paths generated. */
  sampleCount: number;
  /** Last input close price. */
  lastClose: number;
  /** Mean predicted close at horizon. */
  meanPredictedClose: number;
  /** Inference time in milliseconds. */
  inferenceTimeMs: number;
}

interface CacheEntry {
  ts: number;
  data: KronosVolForecast;
}

const cache = new Map<string, CacheEntry>();

/**
 * Run Kronos volatility forecast on OHLCV candles.
 *
 * @param tokenId  - Token identifier (used for caching)
 * @param candles  - Historical OHLCV candles (need at least 30, ideally 200)
 * @param samples  - Number of Monte Carlo paths (default 5)
 * @param predLen  - Number of future candles to predict (default 24)
 * @returns Volatility forecast or null on failure
 */
export async function getKronosVolForecast(
  tokenId: string,
  candles: Candle[],
  samples: number = 5,
  predLen: number = 24,
): Promise<KronosVolForecast | null> {
  // Check cache
  const cacheKey = `kronos:${tokenId}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  if (!candles || candles.length < 30) return null;

  // Prepare input JSON
  const input = JSON.stringify({
    candles: candles.map((c) => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    })),
  });

  const scriptPath = join(FINCEPT_SCRIPTS_DIR, "kronos_predict.py");

  return new Promise<KronosVolForecast | null>((resolve) => {
    const proc = execFile(
      KRONOS_PYTHON,
      [scriptPath, "--samples", String(samples), "--pred-len", String(predLen)],
      {
        timeout: TIMEOUT_MS,
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          console.error(`  [kronos] Inference failed: ${error.message}`);
          resolve(null);
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) {
            console.error(`  [kronos] ${result.error}`);
            resolve(null);
            return;
          }

          const forecast = result as KronosVolForecast;
          cache.set(cacheKey, { ts: Date.now(), data: forecast });
          resolve(forecast);
        } catch {
          console.error(`  [kronos] Invalid JSON output`);
          resolve(null);
        }
      },
    );

    // Write candle data to stdin
    if (proc.stdin) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}
