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

  // BigInts don't serialize by default — stringify them so JSON.parse on
  // the client receives plain strings. Only `agentCount` can surface as a
  // bigint in this view (carried through from the subgraph rows), but
  // SyndicateDisplay widens it to `number`; still, guard generically.
  return NextResponse.json(
    ranked,
    {
      headers: {
        "Cache-Control": "public, max-age=30, s-maxage=30",
      },
    },
  );
}
