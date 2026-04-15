/**
 * Signal smoother — rolling-window average for fast/noisy signals.
 *
 * Some signals (HL orderbook + whale flow, Nansen smart money, DEX 1h flow,
 * funding rate) are measured at a granularity finer than their actual
 * information content. Per-scan readings can flip 100% direction within
 * minutes when the underlying state hasn't meaningfully changed.
 *
 * This module wraps the per-scan reading in a rolling N-reading average
 * before it enters the scoring engine. Disagreement across the window
 * also reduces the signal's confidence — a smoothed value of 0.16 from
 * [+0.5, -0.5, +0.5] reports lower confidence than 0.16 from
 * [0.16, 0.16, 0.17].
 *
 * Slow signals (RSI/MACD/EMA — already smoothed by their indicators,
 * F&G — daily index, multi-timeframe — uses 7d candles) are passed
 * through unchanged.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Signal } from './scoring.js';

/** Signal names whose values benefit from rolling-window smoothing. */
export const FAST_SIGNAL_NAMES = new Set<string>([
  'hyperliquidFlow',
  'smartMoney',
  'onchain',         // legacy direct on-chain signal name
  'dexFlow',
  'fundingRate',
]);

interface SignalReading {
  ts: number;        // epoch ms
  value: number;     // -1 to +1
  confidence: number;
}

/** Per-token, per-signal rolling buffer. */
type Cache = Record<string, Record<string, SignalReading[]>>;

export interface SmootherConfig {
  /** How many readings to retain per (token, signal) buffer. */
  windowSize: number;
  /** Maximum age (ms) for a reading to count toward the average. */
  maxAgeMs: number;
  /** Confidence multiplier when the window has zero std-dev (perfect agreement). */
  agreementBoost: number;
  /** Cap on confidence reduction from disagreement. */
  maxConfidencePenalty: number;
}

export const DEFAULT_SMOOTHER_CONFIG: SmootherConfig = {
  windowSize: 3,
  maxAgeMs: 6 * 60 * 60 * 1000, // 6 hours — drop stale readings
  agreementBoost: 1.0,
  maxConfidencePenalty: 0.5,
};

/** Storage backend interface — disk for live, in-memory map for backtest. */
export interface SmootherStorage {
  load(): Promise<Cache>;
  save(cache: Cache): Promise<void>;
}

/** Disk-backed storage. Atomic write via temp file + rename. */
export class FileSmootherStorage implements SmootherStorage {
  constructor(private filePath: string) {}

  async load(): Promise<Cache> {
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as Cache;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  }

  async save(cache: Cache): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await writeFile(tmp, JSON.stringify(cache), 'utf-8');
    const { rename } = await import('node:fs/promises');
    await rename(tmp, this.filePath);
  }
}

/** In-memory storage — for backtest where state is per-simulation. */
export class MemorySmootherStorage implements SmootherStorage {
  private cache: Cache = {};
  async load(): Promise<Cache> { return this.cache; }
  async save(cache: Cache): Promise<void> { this.cache = cache; }
}

export class SignalSmoother {
  /** In-process mutex chain — serializes load→mutate→save across tokens in
   *  the same process. Does NOT protect against multiple processes racing
   *  the same file; for that, the disk storage does atomic replace and
   *  re-reads the freshest cache inside the mutex. See README / H1 below. */
  private writeLock: Promise<void> = Promise.resolve();

  constructor(
    private storage: SmootherStorage,
    private config: SmootherConfig = DEFAULT_SMOOTHER_CONFIG,
  ) {}

  /**
   * Smooth the given signals for a token. Fast signals get rolling-window
   * averages with confidence penalties for disagreement. Slow signals
   * pass through unchanged. Side effect: appends current readings to the
   * cache and persists.
   *
   * Serialized via writeLock: concurrent calls from within the same
   * process (e.g. parallel per-token smooths) queue on the shared mutex
   * so each sees the freshest cache. Cross-process concurrency (two agent
   * processes on the same host) is NOT fully safe — the second-to-save
   * wins. Document: run one agent per host, or use MemorySmootherStorage
   * in contexts with multiple simulation runs.
   */
  async smooth(tokenId: string, signals: Signal[], nowMs: number = Date.now()): Promise<Signal[]> {
    // Queue on the shared mutex
    const prev = this.writeLock;
    let release: () => void = () => {};
    this.writeLock = new Promise<void>((resolve) => { release = resolve; });
    await prev;

    try {
      return await this.smoothUnlocked(tokenId, signals, nowMs);
    } finally {
      release();
    }
  }

  private async smoothUnlocked(tokenId: string, signals: Signal[], nowMs: number): Promise<Signal[]> {
    const cache = await this.storage.load();
    // M2: sweep stale tokens out of the cache entirely so rotated-out
    // tokens don't leak JSON size indefinitely. A token is "stale" if
    // every signal buffer's newest reading is older than maxAgeMs.
    const cutoff = nowMs - this.config.maxAgeMs;
    for (const t of Object.keys(cache)) {
      if (t === tokenId) continue;
      const buffers = cache[t];
      if (!buffers) continue;
      const bufferList = Object.values(buffers);
      const anyFresh = bufferList.some((b) => b.length > 0 && b[b.length - 1]!.ts >= cutoff);
      if (!anyFresh) {
        delete cache[t];
      }
    }
    if (!cache[tokenId]) cache[tokenId] = {};

    const out: Signal[] = [];
    for (const sig of signals) {
      if (!FAST_SIGNAL_NAMES.has(sig.name)) {
        out.push(sig);
        continue;
      }

      const buffer = cache[tokenId][sig.name] ?? [];

      // Append current reading
      buffer.push({ ts: nowMs, value: sig.value, confidence: sig.confidence });

      // Drop stale readings
      const cutoff = nowMs - this.config.maxAgeMs;
      const fresh = buffer.filter((r) => r.ts >= cutoff);

      // Trim to window size — keep newest N
      const trimmed = fresh.slice(-this.config.windowSize);
      cache[tokenId][sig.name] = trimmed;

      // Compute smoothed value + confidence
      const values = trimmed.map((r) => r.value);
      const meanValue = values.reduce((a, b) => a + b, 0) / values.length;
      const meanConfidence = trimmed.reduce((a, r) => a + r.confidence, 0) / trimmed.length;

      // Std-dev in [-1,1] domain — max possible is 1.0 (alternating +1/-1)
      let smoothedConfidence = meanConfidence;
      if (trimmed.length > 1) {
        const variance = values.reduce((sum, v) => sum + (v - meanValue) ** 2, 0) / values.length;
        const stdDev = Math.sqrt(variance);
        // Penalize confidence proportional to std-dev (clamped)
        const penalty = Math.min(this.config.maxConfidencePenalty, stdDev);
        smoothedConfidence = Math.max(0.05, meanConfidence * (1 - penalty));
      }

      out.push({
        ...sig,
        value: meanValue,
        confidence: smoothedConfidence,
        details: `${sig.details} [smoothed n=${trimmed.length}, raw=${sig.value.toFixed(2)}]`,
      });
    }

    await this.storage.save(cache);
    return out;
  }
}
