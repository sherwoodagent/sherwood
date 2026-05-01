import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBacktest, computeDrawdown, shortHash } from './backtest.js';
import { HistoricalDataLoader, type Bar1m, type AtrPoint, type LoadedSeries } from './historical-data-loader.js';
import { DEFAULT_GRID_CONFIG, type GridConfig } from './config.js';

let tmpOut: string;

beforeEach(async () => {
  tmpOut = await mkdtemp(join(tmpdir(), 'sw-bt-out-'));
});
afterEach(async () => {
  await rm(tmpOut, { recursive: true, force: true });
});

/** Fake loader that returns pre-built series without hitting the network. */
function makeFakeLoader(seriesByToken: Record<string, LoadedSeries>): HistoricalDataLoader {
  return {
    load: async (tokenId: string) => {
      const s = seriesByToken[tokenId];
      if (!s) throw new Error(`no series for ${tokenId}`);
      return s;
    },
  } as unknown as HistoricalDataLoader;
}

/** Build constant-ATR 4h bar series and matching 1m series with given pattern. */
function buildSyntheticSeries(opts: {
  fromMs: number;
  toMs: number;
  priceAt: (t: number) => { o: number; h: number; l: number; c: number };
  fourHourAtr: number;
}): LoadedSeries {
  const minutes: Bar1m[] = [];
  for (let t = opts.fromMs; t < opts.toMs; t += 60_000) {
    const p = opts.priceAt(t);
    minutes.push({ t, o: p.o, h: p.h, l: p.l, c: p.c, v: 1 });
  }
  // 4h bars covering window + 14*4h warmup
  const fourHour: Bar1m[] = [];
  const atrSeries: AtrPoint[] = [];
  const fhStart = opts.fromMs - 14 * 4 * 3600_000;
  for (let t = fhStart; t < opts.toMs; t += 4 * 3600_000) {
    const p = opts.priceAt(Math.max(t, opts.fromMs));
    fourHour.push({ t, o: p.o, h: p.h, l: p.l, c: p.c, v: 1 });
    atrSeries.push({ ts: t, atr: opts.fourHourAtr });
  }
  return { minutes, fourHour, atrSeries };
}

describe('shortHash', () => {
  it('is stable for identical inputs', () => {
    const a = shortHash({ fromMs: 1, toMs: 2, config: DEFAULT_GRID_CONFIG });
    const b = shortHash({ fromMs: 1, toMs: 2, config: DEFAULT_GRID_CONFIG });
    expect(a).toBe(b);
    expect(a).toHaveLength(8);
  });
});

describe('computeDrawdown', () => {
  it('finds peak-to-trough drop on a known curve', () => {
    const curve = [
      { t: 1, totalAllocation: 100, totalPnl: 0,   totalRoundTrips: 0, openFillCount: 0, paused: false },
      { t: 2, totalAllocation: 100, totalPnl: 20,  totalRoundTrips: 0, openFillCount: 0, paused: false },
      { t: 3, totalAllocation: 100, totalPnl: -10, totalRoundTrips: 0, openFillCount: 0, paused: false },
      { t: 4, totalAllocation: 100, totalPnl: 10,  totalRoundTrips: 0, openFillCount: 0, paused: false },
    ];
    const dd = computeDrawdown(curve);
    expect(dd.maxUsd).toBe(30);
    expect(dd.peakAt).toBe(2);
    expect(dd.troughAt).toBe(3);
  });
  it('returns zero on empty curve', () => {
    expect(computeDrawdown([]).maxUsd).toBe(0);
  });
});

describe('runBacktest validation', () => {
  it('rejects from >= to', async () => {
    await expect(runBacktest({
      fromMs: 1000,
      toMs: 500,
      capital: 5000,
      config: DEFAULT_GRID_CONFIG,
      outPath: '',
    })).rejects.toThrow('--from must be before --to');
  });

  it('rejects window < 56h', async () => {
    await expect(runBacktest({
      fromMs: 0,
      toMs: 60 * 60 * 1000,        // 1 hour
      capital: 5000,
      config: DEFAULT_GRID_CONFIG,
      outPath: '',
    })).rejects.toThrow('window too short');
  });

  it('rejects tokenSplit that does not sum to 1.0', async () => {
    const cfg: GridConfig = {
      ...DEFAULT_GRID_CONFIG,
      tokens: ['bitcoin', 'ethereum'],
      tokenSplit: { bitcoin: 0.5, ethereum: 0.4 },
    };
    await expect(runBacktest({
      fromMs: 0,
      toMs: 100 * 3600_000,
      capital: 5000,
      config: cfg,
      outPath: '',
    })).rejects.toThrow('tokenSplit must sum to 1.0');
  });
});

describe('runBacktest replay (synthetic prices)', () => {
  it('flat-line price → zero round trips', async () => {
    const fromMs = 0;
    const toMs = 100 * 3600_000;
    const series = buildSyntheticSeries({
      fromMs, toMs,
      priceAt: () => ({ o: 60000, h: 60000, l: 60000, c: 60000 }),
      fourHourAtr: 100,
    });
    const cfg: GridConfig = {
      ...DEFAULT_GRID_CONFIG,
      tokens: ['bitcoin'],
      tokenSplit: { bitcoin: 1.0 },
    };
    const loader = makeFakeLoader({ bitcoin: series });
    const result = await runBacktest({
      fromMs, toMs, capital: 5000, config: cfg, loader, outPath: '',
    });
    expect(result.totals.roundTrips).toBe(0);
  });

  it('sine-wave around grid center → some round trips', async () => {
    const fromMs = 0;
    const toMs = 100 * 3600_000;
    // Sine wave with amplitude ~150 (within ATR=100 × multiplier=2 = $200 range)
    const priceAt = (t: number) => {
      const phase = (t / 3600_000) * 0.3; // ~3h period
      const mid = 60000 + Math.sin(phase) * 150;
      return { o: mid - 5, h: mid + 5, l: mid - 5, c: mid + 5 };
    };
    const series = buildSyntheticSeries({ fromMs, toMs, priceAt, fourHourAtr: 100 });
    const cfg: GridConfig = {
      ...DEFAULT_GRID_CONFIG,
      tokens: ['bitcoin'],
      tokenSplit: { bitcoin: 1.0 },
      minProfitPerFillUsd: 0, // disable fee floor for predictability
    };
    const loader = makeFakeLoader({ bitcoin: series });
    const result = await runBacktest({
      fromMs, toMs, capital: 5000, config: cfg, loader, outPath: '',
    });
    expect(result.totals.roundTrips).toBeGreaterThan(0);
    expect(result.capital.pnlUsd).toBeGreaterThan(0);
  });
});

describe('runBacktest output', () => {
  it('writes JSON to outPath when provided', async () => {
    const fromMs = 0;
    const toMs = 100 * 3600_000;
    const series = buildSyntheticSeries({
      fromMs, toMs,
      priceAt: () => ({ o: 60000, h: 60000, l: 60000, c: 60000 }),
      fourHourAtr: 100,
    });
    const cfg: GridConfig = {
      ...DEFAULT_GRID_CONFIG,
      tokens: ['bitcoin'],
      tokenSplit: { bitcoin: 1.0 },
    };
    const loader = makeFakeLoader({ bitcoin: series });
    const outPath = join(tmpOut, 'result.json');
    const result = await runBacktest({
      fromMs, toMs, capital: 5000, config: cfg, loader, outPath,
    });
    const written = await import('node:fs/promises').then(fs => fs.readFile(outPath, 'utf-8'));
    const parsed = JSON.parse(written);
    expect(parsed.runId).toBe(result.runId);
    expect(parsed.window.fromMs).toBe(fromMs);
  });

  it('respects snapshotEveryMinutes cadence', async () => {
    const fromMs = 0;
    const toMs = 100 * 3600_000;
    const series = buildSyntheticSeries({
      fromMs, toMs,
      priceAt: () => ({ o: 60000, h: 60000, l: 60000, c: 60000 }),
      fourHourAtr: 100,
    });
    const cfg: GridConfig = {
      ...DEFAULT_GRID_CONFIG,
      tokens: ['bitcoin'],
      tokenSplit: { bitcoin: 1.0 },
    };
    const loader = makeFakeLoader({ bitcoin: series });
    const result = await runBacktest({
      fromMs, toMs, capital: 5000, config: cfg, loader,
      snapshotEveryMinutes: 60, outPath: '',
    });
    // 100h × 60 min/h = 6000 minutes; one snapshot per hour = ~100 + final
    expect(result.equityCurve.length).toBeGreaterThanOrEqual(99);
    expect(result.equityCurve.length).toBeLessThanOrEqual(101);
  });
});
