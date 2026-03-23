"use client";

import { useState } from "react";
import Link from "next/link";
import { CHAIN_BADGES, truncateAddress } from "@/lib/contracts";
import type { SyndicateDisplay } from "@/lib/syndicates";

interface RankedSyndicate extends SyndicateDisplay {
  tvlNum: number;
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
      <div className="flex gap-0 mb-0 border-b border-[var(--color-border)]">
        <button
          onClick={() => setTab("syndicates")}
          className={`px-6 py-3 text-xs uppercase tracking-[0.1em] font-semibold transition-colors border-b-2 -mb-px ${
            tab === "syndicates"
              ? "border-[var(--color-accent)] text-[var(--color-accent)]"
              : "border-transparent text-[rgba(255,255,255,0.4)] hover:text-white"
          }`}
        >
          Syndicates ({syndicates.length})
        </button>
        <button
          onClick={() => setTab("agents")}
          className={`px-6 py-3 text-xs uppercase tracking-[0.1em] font-semibold transition-colors border-b-2 -mb-px ${
            tab === "agents"
              ? "border-[var(--color-accent)] text-[var(--color-accent)]"
              : "border-transparent text-[rgba(255,255,255,0.4)] hover:text-white"
          }`}
        >
          Agents ({agents.length})
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
                    <tr key={`${s.chainId}-${s.id}`}>
                      <td
                        style={{
                          color: "var(--color-accent)",
                          fontWeight: 700,
                        }}
                      >
                        {String(i + 1).padStart(2, "0")}
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
                      <td className="apy-highlight">{s.tvl}</td>
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
                    <tr key={`${a.agentAddress}-${a.syndicateSubdomain}`}>
                      <td
                        style={{
                          color: "var(--color-accent)",
                          fontWeight: 700,
                        }}
                      >
                        {String(i + 1).padStart(2, "0")}
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
                      <td
                        style={{
                          color:
                            a.totalPnlRaw > 0
                              ? "var(--color-accent)"
                              : a.totalPnlRaw < 0
                                ? "#ff4d4d"
                                : "rgba(255,255,255,0.5)",
                          fontWeight: a.totalPnlRaw !== 0 ? 600 : 400,
                        }}
                      >
                        {a.totalPnl}
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
