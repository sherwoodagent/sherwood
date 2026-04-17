import { NextResponse } from "next/server";
import { getRankedSyndicates } from "@/lib/leaderboard-data";

/**
 * JSON feed for the leaderboard's client-side auto-refresh.
 *
 * Server-cached for 30s — a burst of tabs all polling every 30s hits
 * the upstream (subgraph + multicall + CoinGecko) at most once per
 * cache window.
 */
export const revalidate = 30;

export async function GET() {
  const { ranked } = await getRankedSyndicates();

  // SyndicateDisplay is JSON-safe as of today: all onchain bigints are
  // widened to `number` or formatted to `string` upstream in syndicates.ts.
  // If a future field carries a raw bigint through, NextResponse.json
  // will throw — wire a replacer here (or widen at the source) at that
  // point rather than silently serializing "[object Object]".
  return NextResponse.json(ranked, {
    headers: {
      "Cache-Control": "public, max-age=30, s-maxage=30",
    },
  });
}
