import { type Address } from "viem";
import { type ProposalData, ProposalState } from "@/lib/governor-data";
import { truncateAddress, formatAsset, formatBps } from "@/lib/contracts";

interface AgentStatsProps {
  proposals: ProposalData[];
  assetDecimals: number;
  assetSymbol: string;
  addressNames?: Record<string, string>;
}

interface AgentStat {
  address: Address;
  totalProposals: number;
  settled: number;
  rejected: number;
  totalPnl: bigint;
  avgFeeBps: number;
}

export default function AgentStats({
  proposals,
  assetDecimals,
  assetSymbol,
  addressNames,
}: AgentStatsProps) {
  const isUSD = assetSymbol === "USDC" || assetSymbol === "USDT";
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
        {/* <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "9px" }}>
          {sorted.length} AGENTS
        </span> */}
      </div>

      {sorted.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "2rem 0",
            color: "rgba(255,255,255,0.3)",
            fontFamily: "var(--font-plus-jakarta), sans-serif",
            fontSize: "12px",
          }}
        >
          No agent data yet
        </div>
      ) : (
        <table className="log-table">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Proposals</th>
              <th scope="col">Settled</th>
              <th scope="col">Total P&L</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((stat) => {
              const pnlPositive = stat.totalPnl > 0n;
              const pnlNegative = stat.totalPnl < 0n;
              const abs = stat.totalPnl < 0n ? -stat.totalPnl : stat.totalPnl;
              const formatted = formatAsset(abs, assetDecimals, isUSD ? "USD" : undefined);
              const display = isUSD ? formatted : `${formatted} ${assetSymbol}`;
              const pnlText = stat.totalPnl === 0n
                ? "\u2014"
                : `${pnlPositive ? "+" : "-"}${display}`;
              const pnlColor = pnlPositive
                ? "var(--color-accent)"
                : pnlNegative
                  ? "#ff4d4d"
                  : "rgba(255,255,255,0.3)";

              return (
                <tr key={stat.address}>
                  <td>{addressNames?.[stat.address.toLowerCase()] || truncateAddress(stat.address)}</td>
                  <td>{stat.totalProposals}</td>
                  <td style={{ color: "var(--color-accent)" }}>
                    {stat.settled}
                  </td>
                  <td style={{ color: pnlColor, fontWeight: 600 }}>
                    {pnlText}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
