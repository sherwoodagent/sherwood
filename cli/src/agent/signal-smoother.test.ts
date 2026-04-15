/**
 * Tests for SignalSmoother — rolling-window smoothing of fast signals.
 *
 * Covers H1 (concurrency within a process), M2 (stale token eviction),
 * and the core math (window trim, std-dev confidence penalty).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SignalSmoother,
  MemorySmootherStorage,
  DEFAULT_SMOOTHER_CONFIG,
} from './signal-smoother.js';
import type { Signal } from './scoring.js';

function makeSignal(name: string, value: number, confidence = 0.6): Signal {
  return { name, value, confidence, source: name, details: '' };
}

describe('SignalSmoother', () => {
  let storage: MemorySmootherStorage;
  let smoother: SignalSmoother;

  beforeEach(() => {
    storage = new MemorySmootherStorage();
    smoother = new SignalSmoother(storage, DEFAULT_SMOOTHER_CONFIG);
  });

  it('passes slow signals through unchanged', async () => {
    const slow = makeSignal('technical', 0.5, 0.7);
    const [out] = await smoother.smooth('bitcoin', [slow]);
    expect(out).toEqual(slow);
  });

  it('persists rolling buffer across smooth() calls', async () => {
    const t0 = 1_700_000_000_000;
    const sig = (v: number) => makeSignal('hyperliquidFlow', v);

    const [a] = await smoother.smooth('bitcoin', [sig(0.6)], t0);
    const [b] = await smoother.smooth('bitcoin', [sig(0.3)], t0 + 60_000);
    const [c] = await smoother.smooth('bitcoin', [sig(0.9)], t0 + 120_000);

    expect(a!.value).toBe(0.6);                              // n=1
    expect(b!.value).toBeCloseTo(0.45, 5);                   // mean(0.6, 0.3)
    expect(c!.value).toBeCloseTo((0.6 + 0.3 + 0.9) / 3, 5);  // mean(0.6, 0.3, 0.9)
  });

  it('trims buffer to windowSize', async () => {
    const t0 = 1_700_000_000_000;
    const sig = (v: number) => makeSignal('hyperliquidFlow', v);

    // Window defaults to 3. Push 5 readings.
    for (let i = 0; i < 5; i++) {
      await smoother.smooth('bitcoin', [sig(i / 10)], t0 + i * 60_000);
    }

    const cache = await storage.load();
    const buf = cache.bitcoin!.hyperliquidFlow!;
    expect(buf).toHaveLength(DEFAULT_SMOOTHER_CONFIG.windowSize);
    // Newest 3 = 0.2, 0.3, 0.4
    expect(buf.map((r) => r.value)).toEqual([0.2, 0.3, 0.4]);
  });

  it('drops readings older than maxAgeMs', async () => {
    const t0 = 1_700_000_000_000;
    const sig = (v: number) => makeSignal('hyperliquidFlow', v);

    await smoother.smooth('bitcoin', [sig(0.1)], t0);
    // Advance past maxAgeMs (6h default)
    const later = t0 + DEFAULT_SMOOTHER_CONFIG.maxAgeMs + 60_000;
    const [out] = await smoother.smooth('bitcoin', [sig(0.9)], later);
    expect(out!.value).toBe(0.9); // only the fresh reading counted
  });

  it('reduces confidence on high std-dev (disagreement)', async () => {
    const t0 = 1_700_000_000_000;
    const sig = (v: number) => makeSignal('hyperliquidFlow', v, 0.8);

    await smoother.smooth('bitcoin', [sig(1.0)], t0);
    await smoother.smooth('bitcoin', [sig(-1.0)], t0 + 1_000);
    const [out] = await smoother.smooth('bitcoin', [sig(1.0)], t0 + 2_000);

    // Mean = 0.33, std-dev ≈ 0.94, confidence ≈ 0.8 * (1 - min(0.5, 0.94)) = 0.8 * 0.5 = 0.4
    expect(out!.confidence).toBeLessThan(0.5);
  });

  it('keeps confidence high when readings agree (low std-dev)', async () => {
    const t0 = 1_700_000_000_000;
    const sig = (v: number) => makeSignal('hyperliquidFlow', v, 0.8);

    await smoother.smooth('bitcoin', [sig(0.3)], t0);
    await smoother.smooth('bitcoin', [sig(0.31)], t0 + 1_000);
    const [out] = await smoother.smooth('bitcoin', [sig(0.29)], t0 + 2_000);

    expect(out!.confidence).toBeGreaterThan(0.75); // near-original 0.8
  });

  it('evicts stale tokens that drop out of the universe (M2)', async () => {
    const t0 = 1_700_000_000_000;
    const oldAgo = t0 - DEFAULT_SMOOTHER_CONFIG.maxAgeMs - 60_000;

    // Seed storage directly with a stale token
    await storage.save({
      oldtoken: {
        hyperliquidFlow: [{ ts: oldAgo, value: 0.1, confidence: 0.5 }],
      },
    });

    // Touch a different token at t0 — sweep should remove `oldtoken`
    await smoother.smooth('bitcoin', [makeSignal('hyperliquidFlow', 0.5)], t0);

    const cache = await storage.load();
    expect(cache.oldtoken).toBeUndefined();
    expect(cache.bitcoin).toBeDefined();
  });

  it('serializes concurrent smooth() calls within a process (H1)', async () => {
    const t0 = 1_700_000_000_000;
    const sig = (v: number) => makeSignal('hyperliquidFlow', v);

    // Fire 5 overlapping calls. Without the mutex, load→save races would
    // lose some readings. With the mutex, each sees the previous one's state.
    const promises = [
      smoother.smooth('bitcoin', [sig(0.1)], t0 + 1),
      smoother.smooth('bitcoin', [sig(0.2)], t0 + 2),
      smoother.smooth('bitcoin', [sig(0.3)], t0 + 3),
      smoother.smooth('bitcoin', [sig(0.4)], t0 + 4),
      smoother.smooth('bitcoin', [sig(0.5)], t0 + 5),
    ];
    await Promise.all(promises);

    const cache = await storage.load();
    const buf = cache.bitcoin!.hyperliquidFlow!;
    // With windowSize=3, last 3 readings survive — but we must see
    // exactly 3 and they must be from the 5 we submitted (not a partial
    // overwrite where some were clobbered mid-save).
    expect(buf).toHaveLength(3);
    const submitted = new Set([0.1, 0.2, 0.3, 0.4, 0.5]);
    for (const r of buf) {
      expect(submitted.has(r.value)).toBe(true);
    }
  });
});
