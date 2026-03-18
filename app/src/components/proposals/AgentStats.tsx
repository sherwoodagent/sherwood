import { type Address } from "viem";
import { type ProposalData, ProposalState } from "@/lib/governor-data";
import { truncateAddress, formatBps } from "@/lib/contracts";

interface AgentStatsProps {
  proposals: ProposalData[];
}

interface AgentStat {
  address: Address;
  totalProposals: number;
  executed: number;
  settled: number;
  rejected: number;
  cancelled: number;
  avgFeeBps: number;
}

export default function AgentStats({ proposals }: AgentStatsProps) {
  // Aggregate per-agent stats
  const statsMap = new Map<string, AgentStat>();

  for (const p of proposals) {
    const key = p.proposer.toLowerCase();
    let stat = statsMap.get(key);
    if (!stat) {
      stat = {
        address: p.proposer,
        totalProposals: 0,
        executed: 0,
        settled: 0,
        rejected: 0,
        cancelled: 0,
        avgFeeBps: 0,
      };
      statsMap.set(key, stat);
    }

    stat.totalProposals++;

    switch (p.computedState) {
      case ProposalState.Executed:
      case ProposalState.Settled:
        stat.executed++;
        if (p.computedState === ProposalState.Settled) stat.settled++;
        break;
      case ProposalState.Rejected:
        stat.rejected++;
        break;
      case ProposalState.Cancelled:
        stat.cancelled++;
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
    (a, b) => b.settled - a.settled,
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
              <th>Avg Fee</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((stat) => (
              <tr key={stat.address}>
                <td>{truncateAddress(stat.address)}</td>
                <td>{stat.totalProposals}</td>
                <td style={{ color: "var(--color-accent)" }}>
                  {stat.settled}
                </td>
                <td style={{ color: stat.rejected > 0 ? "#ff4d4d" : undefined }}>
                  {stat.rejected}
                </td>
                <td>{formatBps(BigInt(stat.avgFeeBps))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
