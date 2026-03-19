import { type Address } from "viem";
import { type ProposalData, ProposalState } from "@/lib/governor-data";
import { truncateAddress, formatUSDC, formatBps } from "@/lib/contracts";

interface AgentStatsProps {
  proposals: ProposalData[];
}

interface AgentStat {
  address: Address;
  totalProposals: number;
  settled: number;
  rejected: number;
  totalPnl: bigint;
  avgFeeBps: number;
}

export default function AgentStats({ proposals }: AgentStatsProps) {
  const statsMap = new Map<string, AgentStat>();

  for (const p of proposals) {
    const key = p.proposer.toLowerCase();
    let stat = statsMap.get(key);
    if (!stat) {
      stat = {
        address: p.proposer,
        totalProposals: 0,
        settled: 0,
        rejected: 0,
        totalPnl: 0n,
        avgFeeBps: 0,
      };
      statsMap.set(key, stat);
    }

    stat.totalProposals++;

    switch (p.computedState) {
      case ProposalState.Settled:
        stat.settled++;
        if (p.pnl !== undefined) stat.totalPnl += p.pnl;
        break;
      case ProposalState.Rejected:
        stat.rejected++;
        break;
    }
  }

  // Calculate avg fee
  for (const [key, stat] of statsMap) {
    const agentProposals = proposals.filter(
      (p) => p.proposer.toLowerCase() === key,
    );
    const totalFee = agentProposals.reduce(
      (sum, p) => sum + Number(p.performanceFeeBps),
      0,
    );
    stat.avgFeeBps = Math.round(totalFee / agentProposals.length);
  }

  const sorted = Array.from(statsMap.values()).sort(
    (a, b) => Number(b.totalPnl - a.totalPnl),
  );

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Agent Performance</span>
        <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "9px" }}>
          {sorted.length} AGENTS
        </span>
      </div>

      {sorted.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "2rem 0",
            color: "rgba(255,255,255,0.3)",
            fontFamily: "var(--font-jetbrains-mono), monospace",
            fontSize: "12px",
          }}
        >
          No agent data yet
        </div>
      ) : (
        <table className="log-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Proposals</th>
              <th>Settled</th>
              <th>Rejected</th>
              <th>Total P&L</th>
              <th>Avg Fee</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((stat) => {
              const pnlPositive = stat.totalPnl > 0n;
              const pnlNegative = stat.totalPnl < 0n;
              const abs = stat.totalPnl < 0n ? -stat.totalPnl : stat.totalPnl;
              const pnlText = stat.totalPnl === 0n
                ? "—"
                : `${pnlPositive ? "+" : "-"}${formatUSDC(abs)}`;
              const pnlColor = pnlPositive
                ? "var(--color-accent)"
                : pnlNegative
                  ? "#ff4d4d"
                  : "rgba(255,255,255,0.3)";

              return (
                <tr key={stat.address}>
                  <td>{truncateAddress(stat.address)}</td>
                  <td>{stat.totalProposals}</td>
                  <td style={{ color: "var(--color-accent)" }}>
                    {stat.settled}
                  </td>
                  <td style={{ color: stat.rejected > 0 ? "#ff4d4d" : undefined }}>
                    {stat.rejected}
                  </td>
                  <td style={{ color: pnlColor, fontWeight: 600 }}>
                    {pnlText}
                  </td>
                  <td>{formatBps(BigInt(stat.avgFeeBps))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
