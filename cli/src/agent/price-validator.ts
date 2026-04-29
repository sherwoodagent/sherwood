/**
 * Per-token last-known-good-price cache with two validation rules:
 *
 * 1. **Floor**: reject prices below PRICE_FLOOR. A zero or near-zero tick
 *    collapses risk-per-unit (entry - stop) and produces absurd position
 *    sizes; any division against it risks Infinity/NaN propagation.
 *
 * 2. **Delta cap**: if a prior anchor exists and the new tick deviates from
 *    it by more than MAX_DELTA_PCT, reject the new price and retain the
 *    prior anchor. Genuine moves beyond 20% intra-cycle are rare; an
 *    orders-of-magnitude typo is catastrophic.
 *
 * Anchors older than STALE_ANCHOR_MS are treated as absent — a fresh tick
 * is more useful than a day-old reference.
 *
 * Persistence mirrors {@link HyperliquidProvider.persistOiCache}: atomic
 * tmp-rename writes, fire-and-forget, errors logged as warnings so a slow
 * disk never blocks the signal hot path.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Prices below this are rejected outright (USD). */
export const PRICE_FLOOR = 1e-9;

/** Max allowed relative deviation from the prior anchor (fraction, 0.20 = 20%). */
export const MAX_DELTA_PCT = 0.20;

/** Anchors older than this are ignored — better a fresh tick than a stale anchor. */
export const STALE_ANCHOR_MS = 2 * 60 * 60 * 1000; // 2 hours

interface AnchorEntry {
  price: number;
  timestamp: number;
}

export type ValidatorResult =
  | { ok: true; price: number }
  | { ok: false; reason: string };

export class PriceValidator {
  private anchors = new Map<string, AnchorEntry>();
  private cacheDir: string;
  private cacheFile: string;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  /** Monotonic counter so concurrent persist() calls don't collide on the tmp filename. */
  private persistSeq = 0;
  /** Override Date.now() for tests. */
  private clock: () => number;

  constructor(opts?: { cacheDir?: string; clock?: () => number }) {
    this.cacheDir = opts?.cacheDir ?? join(homedir(), '.sherwood', 'agent', 'cache');
    this.cacheFile = join(this.cacheDir, 'price-validator.json');
    this.clock = opts?.clock ?? (() => Date.now());
    // Eager load so first check() finds the anchors populated.
    this.loadPromise = this.load();
  }

  /** Load anchors from disk. Called once at construction. Never throws. */
  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.cacheFile, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, AnchorEntry>;
      if (parsed && typeof parsed === 'object') {
        for (const [token, entry] of Object.entries(parsed)) {
          if (
            entry
            && Number.isFinite(entry.price)
            && Number.isFinite(entry.timestamp)
            && entry.price >= PRICE_FLOOR
          ) {
            this.anchors.set(token, entry);
          }
        }
      }
    } catch {
      // No file, corrupt JSON, or permission error — start empty.
    } finally {
      this.loaded = true;
    }
  }

  /** Awaited by tests that need a deterministic load — not required for normal use. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) await this.loadPromise;
  }

  /**
   * Validate a new tick for `tokenId`. On ok, the anchor is updated and a
   * persist is queued fire-and-forget. On reject, the prior anchor is kept
   * untouched.
   */
  check(tokenId: string, newPrice: number): ValidatorResult {
    // Floor + finite guard — covers 0, negatives, NaN, Infinity.
    if (!Number.isFinite(newPrice) || newPrice < PRICE_FLOOR) {
      return { ok: false, reason: `price ${newPrice} below floor ${PRICE_FLOOR}` };
    }

    const now = this.clock();
    const prior = this.anchors.get(tokenId);
    const priorIsFresh = prior !== undefined && now - prior.timestamp < STALE_ANCHOR_MS;

    if (priorIsFresh) {
      const oldPrice = prior!.price;
      const delta = Math.abs(newPrice - oldPrice) / oldPrice;
      if (delta > MAX_DELTA_PCT) {
        return {
          ok: false,
          reason:
            `delta ${(delta * 100).toFixed(1)}% from anchor $${oldPrice} to $${newPrice} exceeds ${(MAX_DELTA_PCT * 100).toFixed(0)}%`,
        };
      }
    }

    // Accept: update anchor and queue a persist.
    this.anchors.set(tokenId, { price: newPrice, timestamp: now });
    this.persist();
    return { ok: true, price: newPrice };
  }

  /**
   * Persist anchors to disk via atomic tmp-rename. Fire-and-forget — callers
   * do NOT await. Errors are logged as warnings.
   */
  private persist(): void {
    const snapshot: Record<string, AnchorEntry> = {};
    for (const [token, entry] of this.anchors.entries()) {
      snapshot[token] = entry;
    }
    // Unique tmp path per persist() call — prevents concurrent writes from
    // tripping over each other's tmp file. (Two back-to-back check() calls can
    // both fire writes before either rename completes.)
    const seq = ++this.persistSeq;
    const tmp = `${this.cacheFile}.tmp.${process.pid}.${seq}`;
    void (async () => {
      try {
        await mkdir(this.cacheDir, { recursive: true });
        await writeFile(tmp, JSON.stringify(snapshot), 'utf-8');
        await rename(tmp, this.cacheFile);
      } catch (err) {
        console.warn(`[price-validator] persist failed: ${(err as Error).message}`);
      }
    })();
  }
}
