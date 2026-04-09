/**
 * Server-side price quoting API route.
 *
 * Caches prices for 30s so all visitors share one set of RPC calls.
 * POST body: { chainId, tokens: [{ token, decimals, feeTier? }], asset, assetDecimals }
 * Returns: { prices: Record<string, { price: number }> }
 */

import { NextResponse } from "next/server";
import { quoteAllTokenPrices } from "@/lib/price-quote";
import type { Address } from "viem";

interface CacheEntry {
  prices: Record<string, { price: number }>;
  timestamp: number;
}

// In-memory cache keyed by "chainId:asset:tokensSorted"
const cache = new Map<string, CacheEntry>();
const CACHE_TTL = 30_000; // 30s

function buildCacheKey(chainId: number, asset: string, tokens: string[]): string {
  return `${chainId}:${asset}:${[...tokens].sort().join(",")}`;
}

export async function POST(req: Request) {
  try {
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

    const cacheKey = buildCacheKey(chainId, asset, tokens.map((t) => t.token));
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
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

    cache.set(cacheKey, { prices, timestamp: Date.now() });

    return NextResponse.json(prices);
  } catch {
    return NextResponse.json({ error: "Quote failed" }, { status: 500 });
  }
}
