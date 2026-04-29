/**
 * Unit tests for PriceValidator.
 *
 * Covers:
 * - First observation always accepted (no prior anchor).
 * - Ticks within MAX_DELTA_PCT accepted, anchor updates.
 * - Ticks beyond MAX_DELTA_PCT (up or down) rejected, prior anchor retained.
 * - Ticks below PRICE_FLOOR rejected.
 * - Anchor older than STALE_ANCHOR_MS treated as absent.
 * - File persistence survives a second instance over the same cache dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PriceValidator,
  PRICE_FLOOR,
  MAX_DELTA_PCT,
  STALE_ANCHOR_MS,
} from './price-validator.js';

async function waitForFile(path: string, timeoutMs = 1000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await readFile(path, 'utf-8');
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe('PriceValidator', () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'sherwood-pv-test-'));
  });

  afterEach(async () => {
    // Give any in-flight fire-and-forget persist() writes a moment to settle
    // before we tear down the tmp dir — otherwise rmdir can race a rename().
    await new Promise((r) => setTimeout(r, 50));
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('accepts the first observation for a token (no prior anchor)', () => {
    const v = new PriceValidator({ cacheDir });
    const result = v.check('bitcoin', 50_000);
    expect(result).toEqual({ ok: true, price: 50_000 });
  });

  it('accepts a second tick within the delta cap and updates the anchor', () => {
    let now = 1_700_000_000_000;
    const v = new PriceValidator({ cacheDir, clock: () => now });
    v.check('bitcoin', 50_000);
    now += 60_000; // 1 minute later
    // +10% move — within 20% cap
    const result = v.check('bitcoin', 55_000);
    expect(result).toEqual({ ok: true, price: 55_000 });

    // Anchor should now be 55_000: another +10% from 55_000 → 60_500 accepted,
    // but from the original 50_000 that would be +21% (rejected). Prove the
    // anchor was updated by taking a step that only passes from the new anchor.
    now += 60_000;
    const follow = v.check('bitcoin', 60_500);
    expect(follow.ok).toBe(true);
  });

  it('rejects a second tick with a +25% jump and retains the prior anchor', () => {
    let now = 1_700_000_000_000;
    const v = new PriceValidator({ cacheDir, clock: () => now });
    v.check('bitcoin', 50_000);
    now += 60_000;
    const jump = v.check('bitcoin', 62_500); // +25%
    expect(jump.ok).toBe(false);
    if (!jump.ok) expect(jump.reason).toMatch(/delta/i);

    // Anchor should still be 50_000: a +10% move from there (55_000) must pass,
    // proving the 62_500 tick never overwrote the anchor.
    now += 60_000;
    const follow = v.check('bitcoin', 55_000);
    expect(follow).toEqual({ ok: true, price: 55_000 });
  });

  it('rejects a second tick with a -25% drop and retains the prior anchor', () => {
    let now = 1_700_000_000_000;
    const v = new PriceValidator({ cacheDir, clock: () => now });
    v.check('bitcoin', 50_000);
    now += 60_000;
    const drop = v.check('bitcoin', 37_500); // -25%
    expect(drop.ok).toBe(false);

    // Anchor still 50_000 — a -10% move (45_000) passes.
    now += 60_000;
    const follow = v.check('bitcoin', 45_000);
    expect(follow).toEqual({ ok: true, price: 45_000 });
  });

  it('rejects a tick below the price floor', () => {
    const v = new PriceValidator({ cacheDir });
    // Well below 1e-9.
    const result = v.check('some-token', 1e-10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/floor/i);
    // Sanity on the constant so the test fails loudly if the threshold drifts.
    expect(PRICE_FLOOR).toBe(1e-9);
  });

  it('rejects zero, negative, NaN, and Infinity', () => {
    const v = new PriceValidator({ cacheDir });
    expect(v.check('t', 0).ok).toBe(false);
    expect(v.check('t', -50).ok).toBe(false);
    expect(v.check('t', Number.NaN).ok).toBe(false);
    expect(v.check('t', Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it('treats a stale anchor as absent (accepts any finite tick)', () => {
    let now = 1_700_000_000_000;
    const v = new PriceValidator({ cacheDir, clock: () => now });
    v.check('bitcoin', 50_000);

    // Jump well past the stale horizon.
    now += STALE_ANCHOR_MS + 60_000;

    // A +1000% move would normally be rejected, but the anchor is stale.
    const result = v.check('bitcoin', 500_000);
    expect(result).toEqual({ ok: true, price: 500_000 });
  });

  it('persists anchors across instances over the same cache dir', async () => {
    const v1 = new PriceValidator({ cacheDir });
    v1.check('bitcoin', 50_000);
    v1.check('ethereum', 3_000);

    // Wait for the fire-and-forget write to land.
    const cacheFile = join(cacheDir, 'price-validator.json');
    const raw = await waitForFile(cacheFile);
    const parsed = JSON.parse(raw);
    expect(parsed.bitcoin.price).toBe(50_000);
    expect(parsed.ethereum.price).toBe(3_000);

    // Construct a second instance — anchors must load.
    const v2 = new PriceValidator({ cacheDir });
    await v2.ensureLoaded();

    // +25% against the loaded bitcoin anchor must be rejected, proving load().
    const result = v2.check('bitcoin', 62_500);
    expect(result.ok).toBe(false);

    // +10% against the loaded ethereum anchor must be accepted.
    const eth = v2.check('ethereum', 3_300);
    expect(eth.ok).toBe(true);
  });

  it('exports MAX_DELTA_PCT = 0.20 so thresholds match the spec', () => {
    expect(MAX_DELTA_PCT).toBe(0.20);
    expect(STALE_ANCHOR_MS).toBe(2 * 60 * 60 * 1000);
  });
});
