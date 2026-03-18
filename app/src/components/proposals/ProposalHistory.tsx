import {
  type ProposalData,
  ProposalState,
  PROPOSAL_STATE_LABELS,
  formatDuration,
} from "@/lib/governor-data";
import { truncateAddress, formatUSDC, formatBps } from "@/lib/contracts";

interface ProposalHistoryProps {
  proposals: ProposalData[];
}

function StateBadge({ state, pnl }: { state: ProposalState; pnl: bigint }) {
  let bg: string;
  let color: string;

  switch (state) {
    case ProposalState.Settled:
      if (pnl > 0n) {
        bg = "rgba(45, 212, 45, 0.2)";
        color = "var(--color-accent)";
      } else if (pnl < 0n) {
        bg = "rgba(255, 77, 77, 0.2)";
        color = "#ff4d4d";
      } else {
        bg = "rgba(255, 255, 255, 0.1)";
        color = "rgba(255,255,255,0.5)";
      }
      break;
    case ProposalState.Rejected:
      bg = "rgba(255, 77, 77, 0.2)";
      color = "#ff4d4d";
      break;
    case ProposalState.Expired:
    case ProposalState.Cancelled:
      bg = "rgba(255, 255, 255, 0.1)";
      color = "rgba(255,255,255,0.5)";
      break;
    default:
      bg = "rgba(255, 255, 255, 0.1)";
      color = "rgba(255,255,255,0.5)";
  }

  return (
    <span
      style={{
        fontFamily: "var(--font-jetbrains-mono), monospace",
        fontSize: "9px",
        padding: "2px 6px",
        borderRadius: "2px",
        background: bg,
        color: color,
        textTransform: "uppercase",
      }}
    >
      {PROPOSAL_STATE_LABELS[state]}
    </span>
  );
}

export default function ProposalHistory({ proposals }: ProposalHistoryProps) {
  const historical = proposals.filter(
    (p) =>
      p.computedState === ProposalState.Settled ||
      p.computedState === ProposalState.Rejected ||
      p.computedState === ProposalState.Expired ||
      p.computedState === ProposalState.Cancelled,
  );

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Proposal History</span>
        <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "9px" }}>
          {historical.length} TOTAL
        </span>
      </div>

      {historical.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "2rem 0",
            color: "rgba(255,255,255,0.3)",
            fontFamily: "var(--font-jetbrains-mono), monospace",
            fontSize: "12px",
          }}
        >
          No proposal history yet
        </div>
      ) : (
        <table className="log-table">
          <thead>
            <tr>
              <th>#</th>
              <th>State</th>
              <th>Agent</th>
              <th>Capital</th>
              <th>Fee</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {historical.map((p) => {
              // P&L not directly available without settlement event data,
              // but we show capital snapshot for context
              return (
                <tr key={p.id.toString()}>
                  <td>{p.id.toString()}</td>
                  <td>
                    <StateBadge state={p.computedState} pnl={0n} />
                  </td>
                  <td>{truncateAddress(p.proposer)}</td>
                  <td>
                    {p.capitalSnapshot > 0n
                      ? formatUSDC(p.capitalSnapshot)
                      : "—"}
                  </td>
                  <td>{formatBps(p.performanceFeeBps)}</td>
                  <td>{formatDuration(p.strategyDuration)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
