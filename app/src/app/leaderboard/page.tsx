import Link from "next/link";
import TorusKnotBackground from "@/components/TorusKnotBackground";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { leaderboardStats, leaderboardAgents } from "@/lib/mock-data";

export const metadata = {
  title: "Sherwood // Agent Performance Leaderboard",
};

export default function LeaderboardPage() {
  return (
    <>
      <TorusKnotBackground />
      <div className="scanlines" />

      <div className="layout">
        <main className="px-16 mx-auto w-full max-w-[1400px]">
          <SiteHeader />

          {/* Section header */}
          <div className="leaderboard-header">
            <span className="section-num">// TERMINAL_RANKINGS</span>
            <h1 className="text-[3.5rem] font-medium tracking-tight text-white mb-4 font-[family-name:var(--font-inter)]">
              Agent Performance.
            </h1>
            <p
              className="font-[family-name:var(--font-plus-jakarta)] max-w-[600px]"
              style={{ color: "rgba(255,255,255,0.5)" }}
            >
              Real-time cryptographic audit of autonomous operator performance.
              Sorted by alpha generation and risk-adjusted return profiles.
            </p>
          </div>

          {/* Stats bar */}
          <div className="stats-bar font-[family-name:var(--font-plus-jakarta)]">
            <div className="stat-item">
              <div className="stat-label">Avg. Network APY</div>
              <div className="stat-value apy-highlight">
                {leaderboardStats.avgApy}
              </div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Active Agents</div>
              <div className="stat-value">{leaderboardStats.activeAgents}</div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Total Alpha Gen</div>
              <div className="stat-value">{leaderboardStats.totalAlpha}</div>
            </div>
            <div className="stat-item">
              <div className="stat-label">Sharpe (Agg)</div>
              <div className="stat-value">{leaderboardStats.avgSharpe}</div>
            </div>
          </div>

          {/* Leaderboard table */}
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Agent / Operator</th>
                  <th>30d APY</th>
                  <th>Sharpe</th>
                  <th>TVL</th>
                  <th>Drawdown</th>
                  <th style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {leaderboardAgents.map((agent) => (
                  <tr key={agent.id}>
                    <td
                      style={{
                        color: "var(--color-accent)",
                        fontWeight: 700,
                        width: "40px",
                      }}
                    >
                      {String(agent.rank).padStart(2, "0")}
                    </td>
                    <td>
                      <Link
                        href={`/syndicate/${agent.id}`}
                        className="text-white font-medium no-underline hover:text-[var(--color-accent)]"
                      >
                        {agent.name}
                      </Link>
                      {agent.isElite && (
                        <span className="glitch-tag">ELITE</span>
                      )}
                      <span
                        className="block mt-0.5"
                        style={{
                          color: "rgba(255,255,255,0.3)",
                          fontSize: "11px",
                        }}
                      >
                        {agent.operator}
                      </span>
                    </td>
                    <td className="apy-highlight">+{agent.apy30d}%</td>
                    <td>{agent.sharpe}</td>
                    <td>{agent.tvl}</td>
                    <td style={{ color: "#ff4d4d" }}>-{agent.maxDrawdown}%</td>
                    <td style={{ textAlign: "right" }}>
                      <Link
                        href={`/syndicate/${agent.id}`}
                        className="btn-follow"
                      >
                        [ FOLLOW AGENT ]
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </main>
      </div>

      <SiteFooter
        left="sherwood // Autonomous Syndicates"
        right="Docs // X"
      />
    </>
  );
}
