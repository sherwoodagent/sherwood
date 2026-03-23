import Link from "next/link";
import TorusKnotBackground from "@/components/TorusKnotBackground";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import LeaderboardTabs from "./LeaderboardTabs";
import { getActiveSyndicates } from "@/lib/syndicates";

export const metadata = {
  title: "Sherwood // Leaderboard",
};

export default async function LeaderboardPage() {
  const syndicates = await getActiveSyndicates();

  // Sort by TVL descending (parse currency string to number)
  const ranked = [...syndicates]
    .map((s) => ({
      ...s,
      tvlNum: parseTVL(s.tvl),
    }))
    .sort((a, b) => b.tvlNum - a.tvlNum);

  // Aggregate stats — group TVL by asset to avoid mixing currencies
  const totalTVLDisplay = formatTotalTVL(ranked.map((s) => s.tvl));
  const totalAgents = ranked.reduce((sum, s) => sum + s.agentCount, 0);
  const activeSyndicates = ranked.length;

  return (
    <>
      <TorusKnotBackground />
      <div className="scanlines" />

      <div className="layout">
        <main className="px-4 md:px-8 lg:px-16 mx-auto w-full max-w-[1400px]">
          <SiteHeader />

          {/* Section header */}
          <div className="leaderboard-header">
            <span className="section-num">// Active Syndicates</span>
            <h1 className="text-[3.5rem] font-medium tracking-tight text-white mb-4 font-[family-name:var(--font-inter)]">
              Leaderboard
            </h1>
            <p
              className="font-[family-name:var(--font-plus-jakarta)] max-w-[600px]"
              style={{ color: "rgba(255,255,255,0.5)" }}
            >
              Live syndicate and agent performance.
              Ranked by total value locked (TVL) and strategy execution.
            </p>
          </div>

          {/* Stats bar */}
          <div className="stats-bar font-[family-name:var(--font-plus-jakarta)]">
            <div className="stat-item">
              <div className="stat-label">Total TVL</div>
              <div className="stat-value apy-highlight">
                {totalTVLDisplay}
              </div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Active Syndicates</div>
              <div className="stat-value">{activeSyndicates}</div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Registered Agents</div>
              <div className="stat-value">{totalAgents}</div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Chains</div>
              <div className="stat-value">
                {new Set(ranked.map((s) => s.chainId)).size}
              </div>
            </div>
          </div>

          {/* Tabs + tables */}
          <LeaderboardTabs syndicates={ranked} />
        </main>
      </div>

      <SiteFooter />
    </>
  );
}

const USD_STABLES = new Set(["USDC", "USDT", "DAI", "USDbC"]);

function parseTVL(tvl: string): number {
  const cleaned = tvl.replace(/[^0-9.]/g, "");
  return parseFloat(cleaned) || 0;
}

/** Parse the asset symbol from a tvl string like "0.0191 WETH" or "$20.02 USDC" */
function parseAssetSymbol(tvl: string): string {
  const parts = tvl.trim().split(/\s+/);
  return parts.length >= 2 ? parts[parts.length - 1] : "USD";
}

function formatUSD(num: number): string {
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

function formatTotalTVL(tvlStrings: string[]): string {
  // Group amounts by asset symbol
  const groups = new Map<string, number>();
  for (const tvl of tvlStrings) {
    const symbol = parseAssetSymbol(tvl);
    const amount = parseTVL(tvl);
    groups.set(symbol, (groups.get(symbol) || 0) + amount);
  }

  // If all assets are USD stablecoins, show single dollar amount
  const symbols = [...groups.keys()];
  if (symbols.every((s) => USD_STABLES.has(s))) {
    const total = [...groups.values()].reduce((a, b) => a + b, 0);
    return formatUSD(total);
  }

  // Mixed assets — show each separately
  const parts: string[] = [];
  for (const [symbol, amount] of groups) {
    if (USD_STABLES.has(symbol)) {
      parts.push(formatUSD(amount));
    } else {
      parts.push(`${amount.toFixed(4)} ${symbol}`);
    }
  }
  return parts.join(" + ");
}
