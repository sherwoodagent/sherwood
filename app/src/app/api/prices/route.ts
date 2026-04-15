/**
 * Server-side price quoting API route.
 *
 * Caches prices for 30s so all visitors share one set of RPC calls.
 * POST body: { chainId, tokens: [{ token, decimals, feeTier? }], asset, assetDecimals }
 * Returns: { prices: Record<string, { price: number }> }
 */

import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { quoteAllTokenPrices } from "@/lib/price-quote";
import { makeRateLimit } from "@/lib/rate-limit";
import type { Address } from "viem";

interface CacheEntry {
  prices: Record<string, { price: number }>;
  timestamp: number;
}

// In-memory cache keyed by "chainId:asset:tokensSorted".
// Bounded to MAX_CACHE_ENTRIES to prevent unbounded growth — a varied query
// space (different chains, asset combos, token sets) would otherwise leak
// memory on long-lived processes. LRU-ish eviction via insertion order: when
// the cap is hit we evict the oldest entry. A periodic TTL sweep also keeps
// stale entries from sticking around past CACHE_TTL.
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 30_000; // 30s
const MAX_CACHE_ENTRIES = 500;
const CACHE_SWEEP_INTERVAL_MS = 5 * 60_000;
const MAX_TOKENS_PER_REQUEST = 25;
let lastCacheSweep = Date.now();

const checkRateLimit = makeRateLimit({ windowMs: 60_000, max: 60 });

function buildCacheKey(chainId: number, asset: string, tokens: string[]): string {
  return `${chainId}:${asset}:${[...tokens].sort().join(",")}`;
}

function sweepCache(now: number) {
  for (const [key, entry] of cache) {
    if (now - entry.timestamp >= CACHE_TTL) cache.delete(key);
  }
  lastCacheSweep = now;
}

function setCached(key: string, entry: CacheEntry) {
  // Evict oldest while at the cap. Map iteration is insertion order — the
  // first `keys().next().value` is the oldest write.
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  // Bump LRU position by deleting + reinserting on each refresh.
  cache.delete(key);
  cache.set(key, entry);
}

export async function POST(req: Request) {
  try {
    if (!checkRateLimit(req)) {
      return NextResponse.json(
        { error: "Rate limit exceeded — try again in a minute." },
        { status: 429 },
      );
    }

    const body = await req.json();
    const { chainId, tokens, asset, assetDecimals } = body as {
      chainId: number;
      tokens: { token: string; decimals: number; feeTier?: number }[];
      asset: string;
      assetDecimals: number;
    };

    if (!chainId || !tokens?.length || !asset) {
      return NextResponse.json({ error: "Missing params" }, { status: 400 });
    }

    if (tokens.length > MAX_TOKENS_PER_REQUEST) {
      return NextResponse.json(
        { error: `Too many tokens. Max ${MAX_TOKENS_PER_REQUEST} per request.` },
        { status: 400 },
      );
    }

    if (!isAddress(asset)) {
      return NextResponse.json({ error: "Invalid asset address" }, { status: 400 });
    }
    for (const t of tokens) {
      if (!isAddress(t.token)) {
        return NextResponse.json(
          { error: `Invalid token address: ${t.token}` },
          { status: 400 },
        );
      }
      if (typeof t.decimals !== "number" || t.decimals < 0 || t.decimals > 36) {
        return NextResponse.json(
          { error: `Invalid decimals for ${t.token}` },
          { status: 400 },
        );
      }
    }

    const now = Date.now();
    if (now - lastCacheSweep > CACHE_SWEEP_INTERVAL_MS) sweepCache(now);

    const cacheKey = buildCacheKey(chainId, asset, tokens.map((t) => t.token));
    const cached = cache.get(cacheKey);
    if (cached && now - cached.timestamp < CACHE_TTL) {
      return NextResponse.json(cached.prices);
    }

    const priceMap = await quoteAllTokenPrices(
      chainId,
      tokens.map((t) => ({
        token: t.token as Address,
        decimals: t.decimals,
        feeTier: t.feeTier,
      })),
      asset as Address,
      assetDecimals,
    );

    const prices: Record<string, { price: number }> = {};
    for (const [addr, tp] of priceMap.entries()) {
      prices[addr] = { price: tp.price };
    }

    setCached(cacheKey, { prices, timestamp: Date.now() });

    return NextResponse.json(prices);
  } catch {
    return NextResponse.json({ error: "Quote failed" }, { status: 500 });
  }
}
