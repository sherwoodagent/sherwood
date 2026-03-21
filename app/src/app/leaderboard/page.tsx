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

  // Aggregate stats
  const totalTVL = ranked.reduce((sum, s) => sum + s.tvlNum, 0);
  const totalAgents = ranked.reduce((sum, s) => sum + s.agentCount, 0);
  const activeSyndicates = ranked.length;

  return (
    <>
      <TorusKnotBackground />
      <div className="scanlines" />

      <div className="layout">
        <main className="px-16 mx-auto w-full max-w-[1400px]">
          <SiteHeader />

          {/* Section header */}
          <div className="leaderboard-header">
            <span className="section-num">//</span>
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
                {formatUSD(totalTVL)}
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

function parseTVL(tvl: string): number {
  const cleaned = tvl.replace(/[^0-9.]/g, "");
  return parseFloat(cleaned) || 0;
}

function formatUSD(num: number): string {
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}
