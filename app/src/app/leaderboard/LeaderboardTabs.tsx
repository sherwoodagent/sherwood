"use client";

import { useState } from "react";
import Link from "next/link";
import { CHAIN_BADGES, truncateAddress } from "@/lib/contracts";
import type { SyndicateDisplay } from "@/lib/syndicates";

interface RankedSyndicate extends SyndicateDisplay {
  tvlNum: number;
  tvlUSDDisplay: string;
}

interface LeaderboardTabsProps {
  syndicates: RankedSyndicate[];
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  ACTIVE_STRATEGY: { bg: "rgba(46,230,166,0.15)", text: "#2EE6A6" },
  VOTING: { bg: "rgba(234,179,8,0.15)", text: "#eab308" },
  IDLE: { bg: "rgba(255,255,255,0.08)", text: "rgba(255,255,255,0.5)" },
  NO_AGENTS: { bg: "rgba(255,77,77,0.15)", text: "#ff4d4d" },
};

// Rank medal — gold/silver/bronze for top 3, plain mono digits thereafter.
function RankCell({ index }: { index: number }) {
  const medalClass =
    index === 0
      ? "rank-medal rank-medal--gold"
      : index === 1
        ? "rank-medal rank-medal--silver"
        : index === 2
          ? "rank-medal rank-medal--bronze"
          : null;
  if (medalClass) {
    return <span className={medalClass}>{String(index + 1).padStart(2, "0")}</span>;
  }
  return <span className="rank-plain">{String(index + 1).padStart(2, "0")}</span>;
}

// Directional P&L cell — arrow + monospace tabular number.
// Strips a leading +/- if present so the CSS ▲/▼ can own direction cue.
function PnlDelta({ value, raw }: { value: string; raw: number }) {
  const dir = raw > 0 ? "up" : raw < 0 ? "down" : "flat";
  const label =
    raw === 0
      ? value
      : value.replace(/^[+-]/, ""); // drop leading sign; arrow carries direction
  return <span className={`pnl-delta pnl-delta--${dir}`}>{label}</span>;
}

export default function LeaderboardTabs({ syndicates }: LeaderboardTabsProps) {
  const [tab, setTab] = useState<"syndicates" | "agents">("syndicates");

  // Build agent list from syndicates — one row per agent per syndicate,
  // sorted by P&L descending.
  const agents = syndicates
    .flatMap((s) =>
      s.agents.map((a) => ({
        agentAddress: a.agentAddress,
        agentId: a.agentId,
        agentName: a.agentName,
        proposalCount: a.proposalCount,
        totalPnl: a.totalPnl,
        totalPnlRaw: a.totalPnlRaw,
        syndicateSubdomain: s.subdomain,
        syndicateName: s.name,
        chainId: s.chainId,
      })),
    )
    .sort((a, b) => b.totalPnlRaw - a.totalPnlRaw);

  return (
    <div className="font-[family-name:var(--font-plus-jakarta)]">
      {/* Tab switcher */}
      <div className="flex gap-1 mb-0 border-b border-[var(--color-border)]" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "syndicates"}
          onClick={() => setTab("syndicates")}
          className="lb-tab"
        >
          Syndicates
          <span className="lb-tab__count">{String(syndicates.length).padStart(2, "0")}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "agents"}
          onClick={() => setTab("agents")}
          className="lb-tab"
        >
          Agents
          <span className="lb-tab__count">{String(agents.length).padStart(2, "0")}</span>
        </button>
      </div>

      {/* Syndicates tab */}
      {tab === "syndicates" && (
        <div className="table-container" style={{ borderTop: "none" }}>
          {syndicates.length === 0 ? (
            <div className="py-16 text-center text-[rgba(255,255,255,0.3)] text-sm">
              No active syndicates found.
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col" style={{ width: "40px" }}>Rank</th>
                  <th scope="col">Syndicate</th>
                  <th scope="col">Strategy</th>
                  <th scope="col">TVL</th>
                  <th scope="col">Agents</th>
                  <th scope="col">Status</th>
                  <th scope="col">Chain</th>
                  <th scope="col" style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {syndicates.map((s, i) => {
                  const badge = CHAIN_BADGES[s.chainId];
                  const status = STATUS_COLORS[s.status] || STATUS_COLORS.IDLE;
                  return (
                    <tr key={`${s.chainId}-${s.id}`} className={i === 0 ? "lb-row-top1" : undefined}>
                      <td>
                        <RankCell index={i} />
                      </td>
                      <td>
                        <Link
                          href={`/syndicate/${s.subdomain}`}
                          className="text-white font-medium no-underline hover:text-[var(--color-accent)] transition-colors"
                        >
                          {s.name}
                        </Link>
                        <span
                          className="block mt-0.5"
                          style={{
                            color: "rgba(255,255,255,0.3)",
                            fontSize: "11px",
                          }}
                        >
                          {s.subdomain}.sherwoodagent.eth
                        </span>
                      </td>
                      <td
                        style={{
                          color: "rgba(255,255,255,0.6)",
                          fontSize: "12px",
                        }}
                      >
                        {s.strategy || "—"}
                      </td>
                      <td className="apy-highlight">
                        {s.tvl}
                        {s.tvlUSDDisplay && !s.tvl.startsWith("$") && (
                          <span className="block mt-0.5" style={{ color: "rgba(255,255,255,0.35)", fontSize: "10px" }}>
                            ~{s.tvlUSDDisplay}
                          </span>
                        )}
                      </td>
                      <td>{s.agentCount}</td>
                      <td>
                        <span
                          style={{
                            background: status.bg,
                            color: status.text,
                            padding: "2px 8px",
                            borderRadius: "3px",
                            fontSize: "10px",
                            fontWeight: 600,
                            letterSpacing: "0.05em",
                          }}
                        >
                          {s.status.replace("_", " ")}
                        </span>
                      </td>
                      <td>
                        {badge && (
                          <span
                            style={{
                              background: badge.bg,
                              color: badge.color,
                              padding: "2px 8px",
                              borderRadius: "3px",
                              fontSize: "10px",
                              fontWeight: 600,
                            }}
                          >
                            {badge.label}
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link
                          href={`/syndicate/${s.subdomain}`}
                          className="btn-follow"
                        >
                          [ VIEW ]
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Agents tab */}
      {tab === "agents" && (
        <div className="table-container" style={{ borderTop: "none" }}>
          {agents.length === 0 ? (
            <div className="py-16 text-center text-[rgba(255,255,255,0.3)] text-sm">
              No registered agents found.
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col" style={{ width: "40px" }}>#</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Syndicate</th>
                  <th scope="col">Strategies</th>
                  <th scope="col">P&L</th>
                  <th scope="col">Chain</th>
                  <th scope="col" style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a, i) => {
                  const badge = CHAIN_BADGES[a.chainId];
                  return (
                    <tr key={`${a.agentAddress}-${a.syndicateSubdomain}`} className={i === 0 ? "lb-row-top1" : undefined}>
                      <td>
                        <RankCell index={i} />
                      </td>
                      <td>
                        <span className="text-white font-medium">
                          {a.agentName || truncateAddress(a.agentAddress)}
                        </span>
                        <span
                          className="block mt-0.5"
                          style={{
                            color: a.agentName ? "rgba(255,255,255,0.3)" : "var(--color-accent)",
                            fontSize: "10px",
                            opacity: a.agentName ? 1 : 0.7,
                          }}
                        >
                          {a.agentName
                            ? `${truncateAddress(a.agentAddress)} · ERC-8004 #${a.agentId}`
                            : `ERC-8004 #${a.agentId}`}
                        </span>
                      </td>
                      <td>
                        <Link
                          href={`/syndicate/${a.syndicateSubdomain}`}
                          className="text-white font-medium no-underline hover:text-[var(--color-accent)] transition-colors"
                        >
                          {a.syndicateName}
                        </Link>
                        <span
                          className="block mt-0.5"
                          style={{
                            color: "rgba(255,255,255,0.3)",
                            fontSize: "11px",
                          }}
                        >
                          {a.syndicateSubdomain}.sherwoodagent.eth
                        </span>
                      </td>
                      <td>{a.proposalCount}</td>
                      <td>
                        <PnlDelta value={a.totalPnl} raw={a.totalPnlRaw} />
                      </td>
                      <td>
                        {badge && (
                          <span
                            style={{
                              background: badge.bg,
                              color: badge.color,
                              padding: "2px 8px",
                              borderRadius: "3px",
                              fontSize: "10px",
                              fontWeight: 600,
                            }}
                          >
                            {badge.label}
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link
                          href={`/syndicate/${a.syndicateSubdomain}/agents`}
                          className="btn-follow"
                        >
                          [ VIEW AGENT ]
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
