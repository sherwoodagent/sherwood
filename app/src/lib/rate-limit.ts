/**
 * Lightweight per-IP rate limiter for API routes.
 *
 * Per-instance only — fine for low-traffic deployments. For multi-instance
 * production deployments, swap the in-memory Map for a Redis-backed store.
 *
 * Usage:
 *   const limit = makeRateLimit({ windowMs: 60_000, max: 60 });
 *   if (!limit(req)) return new NextResponse(..., { status: 429 });
 */

interface Bucket {
  count: number;
  resetAt: number;
}

interface Options {
  windowMs: number;
  max: number;
}

/** Resolve a stable client identifier from a Request. Falls back to a
 *  literal "unknown" so we still rate-limit pathological no-IP cases
 *  (single shared bucket is acceptable behaviour for that edge). */
function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

/** Sweep expired buckets every 5 minutes to prevent unbounded memory growth
 *  under IP rotation or sustained traffic. Without this the Map accumulates
 *  one entry per unique IP for the lifetime of the process. */
const SWEEP_INTERVAL_MS = 5 * 60_000;

export function makeRateLimit({ windowMs, max }: Options) {
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  return function checkRateLimit(req: Request): boolean {
    const now = Date.now();

    if (now - lastSweep > SWEEP_INTERVAL_MS) {
      for (const [key, entry] of buckets) {
        if (entry.resetAt < now) buckets.delete(key);
      }
      lastSweep = now;
    }

    const ip = clientIp(req);
    const entry = buckets.get(ip);
    if (!entry || entry.resetAt < now) {
      buckets.set(ip, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count++;
    return true;
  };
}
