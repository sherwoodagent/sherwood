/**
 * Historical data loader for the grid backtester.
 *
 * Fetches and caches 1-minute and 4-hour candles from Hyperliquid's
 * candleSnapshot endpoint. Pre-computes ATR(14) for the 4-hour series.
 * Cache lives at ~/.sherwood/grid/backtest-cache/.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TOKEN_TO_COIN } from '../providers/data/hyperliquid.js';
import { calculateATR } from '../agent/technical.js';

const HYPERLIQUID_BASE = 'https://api.hyperliquid.xyz/info';
const DEFAULT_CACHE_DIR = join(homedir(), '.sherwood', 'grid', 'backtest-cache');

export interface Bar1m {
  t: number;     // open timestamp ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface AtrPoint {
  ts: number;    // 4h bar close timestamp
  atr: number;
}

export interface LoadedSeries {
  minutes: Bar1m[];
  fourHour: Bar1m[];
  atrSeries: AtrPoint[];
}

export interface HistoricalDataLoaderOpts {
  cacheDir?: string;
  noCache?: boolean;
  /** Injectable for tests. Default: global fetch. */
  fetchImpl?: typeof fetch;
}

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const ONE_MIN_MS = 60 * 1000;
const ATR_PERIOD = 14;
const ATR_WARMUP_MS = ATR_PERIOD * FOUR_HOURS_MS;
const HL_MAX_BARS_PER_REQUEST = 5000;

export class HistoricalDataLoader {
  private cacheDir: string;
  private noCache: boolean;
  private fetchImpl: typeof fetch;

  constructor(opts: HistoricalDataLoaderOpts = {}) {
    this.cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
    this.noCache = opts.noCache ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Load 1-minute bars and an aligned ATR(14) series for `coinTokenId`
   * (CoinGecko ID; resolved internally to HL coin symbol).
   *
   * The 4-hour series is fetched with ATR_WARMUP_MS extra prefix so ATR
   * is well-defined at fromMs.
   */
  async load(coinTokenId: string, fromMs: number, toMs: number): Promise<LoadedSeries> {
    const coin = TOKEN_TO_COIN[coinTokenId];
    if (!coin) throw new Error(`Unknown token: ${coinTokenId}`);

    const minutes = await this.loadInterval(coin, '1m', fromMs, toMs);
    if (minutes.length === 0) {
      throw new Error(`no data for ${coinTokenId} in window — token may not be listed yet on HL`);
    }

    const fourHour = await this.loadInterval(coin, '4h', fromMs - ATR_WARMUP_MS, toMs);
    const atrSeries = computeAtrSeries(fourHour);

    return { minutes, fourHour, atrSeries };
  }

  /** Fetch + cache one interval. Public for unit testing. */
  async loadInterval(
    coin: string,
    interval: '1m' | '4h',
    fromMs: number,
    toMs: number,
  ): Promise<Bar1m[]> {
    if (!this.noCache) {
      const cached = await this.tryReadCache(coin, interval, fromMs, toMs);
      if (cached) return cached;
    }

    const fresh = await this.fetchPaginated(coin, interval, fromMs, toMs);
    if (!this.noCache && fresh.length > 0) {
      await this.writeCache(coin, interval, fromMs, toMs, fresh);
    }
    return fresh;
  }

  private async tryReadCache(
    coin: string,
    interval: '1m' | '4h',
    fromMs: number,
    toMs: number,
  ): Promise<Bar1m[] | null> {
    const path = this.cachePath(coin, interval, fromMs, toMs);
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as { bars: Bar1m[] };
      if (!Array.isArray(parsed.bars)) return null;
      return parsed.bars;
    } catch {
      return null;
    }
  }

  private async writeCache(
    coin: string,
    interval: '1m' | '4h',
    fromMs: number,
    toMs: number,
    bars: Bar1m[],
  ): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const path = this.cachePath(coin, interval, fromMs, toMs);
    const body = JSON.stringify({
      coin,
      interval,
      fetchedAt: Date.now(),
      bars,
    });
    await writeFile(path, body, 'utf-8');
  }

  private cachePath(coin: string, interval: '1m' | '4h', fromMs: number, toMs: number): string {
    return join(this.cacheDir, `${coin}-${interval}-${fromMs}-${toMs}.json`);
  }

  /** Paginate `candleSnapshot` until we cover [fromMs, toMs]. Dedup on merge. */
  private async fetchPaginated(
    coin: string,
    interval: '1m' | '4h',
    fromMs: number,
    toMs: number,
  ): Promise<Bar1m[]> {
    const intervalMs = interval === '1m' ? ONE_MIN_MS : FOUR_HOURS_MS;
    const pageSpanMs = HL_MAX_BARS_PER_REQUEST * intervalMs;
    const seen = new Set<number>();
    const all: Bar1m[] = [];

    let cursor = fromMs;
    while (cursor < toMs) {
      const pageEnd = Math.min(cursor + pageSpanMs, toMs);
      const page = await this.fetchPageWithRetry(coin, interval, cursor, pageEnd);
      if (page.length === 0) break;

      for (const bar of page) {
        if (!seen.has(bar.t)) {
          seen.add(bar.t);
          all.push(bar);
        }
      }
      // Advance cursor to one interval past the last bar to avoid re-fetching
      const last = page[page.length - 1]!;
      const next = last.t + intervalMs;
      if (next <= cursor) break; // safety: HL returned older bars than requested
      cursor = next;
    }

    all.sort((a, b) => a.t - b.t);
    return all;
  }

  private async fetchPageWithRetry(
    coin: string,
    interval: '1m' | '4h',
    startTime: number,
    endTime: number,
  ): Promise<Bar1m[]> {
    const delays = [1000, 2000, 4000];
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < delays.length + 1; attempt++) {
      try {
        return await this.fetchPage(coin, interval, startTime, endTime);
      } catch (err) {
        lastErr = err as Error;
        if (attempt < delays.length) {
          await sleep(delays[attempt]!);
        }
      }
    }
    throw lastErr ?? new Error('fetchPage failed');
  }

  private async fetchPage(
    coin: string,
    interval: '1m' | '4h',
    startTime: number,
    endTime: number,
  ): Promise<Bar1m[]> {
    const res = await this.fetchImpl(HYPERLIQUID_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'candleSnapshot',
        req: { coin, interval, startTime, endTime },
      }),
    });
    if (!res.ok) throw new Error(`HL ${res.status}: ${await res.text()}`);

    const raw = await res.json() as Array<{
      t: number; T: number; o: string; h: string; l: string; c: string; v: string;
    }>;
    if (!Array.isArray(raw)) return [];

    return raw.map(c => ({
      t: c.t,
      o: Number(c.o),
      h: Number(c.h),
      l: Number(c.l),
      c: Number(c.c),
      v: Number(c.v),
    })).filter(b =>
      Number.isFinite(b.o) && Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c)
    );
  }
}

function computeAtrSeries(fourHourBars: Bar1m[]): AtrPoint[] {
  if (fourHourBars.length < ATR_PERIOD) return [];

  const candles = fourHourBars.map(b => ({
    timestamp: b.t,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));

  const atrArr = calculateATR(candles, ATR_PERIOD);
  const out: AtrPoint[] = [];
  for (let i = 0; i < atrArr.length; i++) {
    if (Number.isFinite(atrArr[i]!)) {
      out.push({ ts: fourHourBars[i]!.t, atr: atrArr[i]! });
    }
  }
  return out;
}

/** Lookup ATR at backtest time `t`. Binary-search; returns last value with ts ≤ t.
 *  Returns null if t is before the first available ATR (warmup not satisfied). */
export function lookupAtr(series: AtrPoint[], t: number): number | null {
  if (series.length === 0 || t < series[0]!.ts) return null;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid]!.ts <= t) lo = mid; else hi = mid - 1;
  }
  return series[lo]!.atr;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
