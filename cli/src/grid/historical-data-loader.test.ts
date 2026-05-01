import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoricalDataLoader, lookupAtr, type Bar1m } from './historical-data-loader.js';
import { calculateATR } from '../agent/technical.js';

let tmpCache: string;

beforeEach(async () => {
  tmpCache = await mkdtemp(join(tmpdir(), 'sw-bt-cache-'));
});

afterEach(async () => {
  await rm(tmpCache, { recursive: true, force: true });
});

function makeBar(t: number, base: number): Bar1m {
  return { t, o: base, h: base + 10, l: base - 10, c: base + 5, v: 1 };
}

describe('HistoricalDataLoader', () => {
  it('cache hit: reads from disk without invoking fetch', async () => {
    const cachedBars: Bar1m[] = [makeBar(1000, 100), makeBar(2000, 110)];
    const cacheFile = join(tmpCache, 'BTC-1m-1000-3000.json');
    await writeFile(cacheFile, JSON.stringify({
      coin: 'BTC',
      interval: '1m',
      fetchedAt: Date.now(),
      bars: cachedBars,
    }));

    const fetchMock = vi.fn();
    const loader = new HistoricalDataLoader({
      cacheDir: tmpCache,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const bars = await loader.loadInterval('BTC', '1m', 1000, 3000);
    expect(bars).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pagination: makes N requests for a span larger than HL_MAX_BARS_PER_REQUEST', async () => {
    // 1m interval, page span = 5000 minutes. Request 12000 minutes → 3 pages.
    const fromMs = 0;
    const toMs = 12000 * 60_000;

    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const start: number = body.req.startTime;
      const end: number = body.req.endTime;
      // Return one bar per minute in [start, end), capped at 5000 bars.
      const bars: Array<{ t: number; o: string; h: string; l: string; c: string; v: string; T: number }> = [];
      let t = start;
      while (t < end && bars.length < 5000) {
        bars.push({ t, T: t + 60_000, o: '100', h: '101', l: '99', c: '100.5', v: '1' });
        t += 60_000;
      }
      return new Response(JSON.stringify(bars), { status: 200 });
    });

    const loader = new HistoricalDataLoader({
      cacheDir: tmpCache,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const bars = await loader.loadInterval('BTC', '1m', fromMs, toMs);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    // 12000 unique minutes
    expect(bars.length).toBe(12000);
    // Strictly increasing timestamps, no dupes
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i]!.t).toBeGreaterThan(bars[i - 1]!.t);
    }
  });

  it('boundary dedup: overlapping pages do not produce duplicate timestamps', async () => {
    // Force HL to return overlapping bars at page boundary
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      callCount++;
      const body = JSON.parse(init.body as string);
      const start: number = body.req.startTime;
      // Each page returns 100 bars starting at `start`, but second call also includes start-60_000 (overlap).
      const bars: Array<{ t: number; o: string; h: string; l: string; c: string; v: string; T: number }> = [];
      const begin = callCount === 2 ? start - 60_000 : start;
      for (let i = 0; i < 100; i++) {
        const t = begin + i * 60_000;
        bars.push({ t, T: t + 60_000, o: '1', h: '1', l: '1', c: '1', v: '1' });
      }
      return new Response(JSON.stringify(bars), { status: 200 });
    });
    const loader = new HistoricalDataLoader({
      cacheDir: tmpCache,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const bars = await loader.loadInterval('BTC', '1m', 0, 200 * 60_000);
    const set = new Set(bars.map(b => b.t));
    expect(set.size).toBe(bars.length); // no dupes
  });

  it('ATR rolling computation matches calculateATR (cross-check)', async () => {
    // Build 50 4h bars with hand-crafted true ranges
    const bars: Bar1m[] = [];
    for (let i = 0; i < 50; i++) {
      bars.push({
        t: i * 4 * 3600_000,
        o: 100 + i,
        h: 100 + i + 5,
        l: 100 + i - 5,
        c: 100 + i + 1,
        v: 1,
      });
    }

    // Cross-check: last ATR from calculateATR
    const candles = bars.map(b => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
    const atrArr = calculateATR(candles, 14);
    const lastAtr = atrArr[atrArr.length - 1]!;
    expect(Number.isFinite(lastAtr)).toBe(true);

    // Use load() with mocked fetch returning 1m + 4h
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.req.interval === '1m') {
        return new Response(JSON.stringify([
          { t: 49 * 4 * 3600_000, T: 49 * 4 * 3600_000 + 60_000, o: '100', h: '100', l: '100', c: '100', v: '0' },
        ]), { status: 200 });
      }
      // 4h
      return new Response(JSON.stringify(bars.map(b => ({
        t: b.t, T: b.t + 4 * 3600_000,
        o: String(b.o), h: String(b.h), l: String(b.l), c: String(b.c), v: String(b.v),
      }))), { status: 200 });
    });
    const loader = new HistoricalDataLoader({
      cacheDir: join(tmpCache, 'cross'),
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    await mkdir(join(tmpCache, 'cross'), { recursive: true });
    const series = await loader.load('bitcoin', 49 * 4 * 3600_000, 49 * 4 * 3600_000 + 60_000);
    const lastSeriesAtr = series.atrSeries[series.atrSeries.length - 1]!.atr;
    expect(Math.abs(lastSeriesAtr - lastAtr)).toBeLessThan(1e-9);
  });
});

describe('lookupAtr', () => {
  it('returns null when t is before warmup', () => {
    const series = [{ ts: 1000, atr: 5 }, { ts: 2000, atr: 6 }];
    expect(lookupAtr(series, 500)).toBeNull();
  });
  it('returns the latest ts ≤ t', () => {
    const series = [{ ts: 1000, atr: 5 }, { ts: 2000, atr: 6 }, { ts: 3000, atr: 7 }];
    expect(lookupAtr(series, 1500)).toBe(5);
    expect(lookupAtr(series, 2000)).toBe(6);
    expect(lookupAtr(series, 2999)).toBe(6);
    expect(lookupAtr(series, 3000)).toBe(7);
    expect(lookupAtr(series, 9999)).toBe(7);
  });
});
