import AmbientBackground from "@/components/AmbientBackground";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import LeaderboardTabs from "./LeaderboardTabs";
import {
  getRankedSyndicates,
  formatTotalTVL,
} from "@/lib/leaderboard-data";

export const metadata = {
  title: "Sherwood // Leaderboard",
};

/** Revalidate every 30s so the auto-refresh in LeaderboardTabs picks up
    fresh data without hammering the underlying subgraph + multicall. */
export const revalidate = 30;

export default async function LeaderboardPage() {
  const { ranked, tokenPrices } = await getRankedSyndicates();

  // Aggregate stats — convert all TVL to USD
  const totalTVLDisplay = formatTotalTVL(
    ranked.map((s) => s.tvl),
    tokenPrices,
  );
  const totalAgents = new Set(
    ranked.flatMap((s) => s.agents.map((a) => a.agentAddress.toLowerCase())),
  ).size;
  const activeSyndicates = ranked.length;

  return (
    <>
      <AmbientBackground />
      <div className="scanlines" />

      <div className="layout">
        <main className="px-4 md:px-8 lg:px-16 mx-auto w-full max-w-[1400px]">
          <SiteHeader />

          {/* Section header */}
          <div className="leaderboard-header">
            <div className="lb-meta">
              <span className="lb-meta__pulse">{"// Live Sync"}</span>
              <span className="lb-meta__sep" aria-hidden />
              <span>LB.001 · Ranked by TVL</span>
              <span className="lb-meta__sep" aria-hidden />
              <span>Base · HyperEVM</span>
            </div>
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
