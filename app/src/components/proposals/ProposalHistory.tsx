import {
  type ProposalData,
  ProposalState,
  PROPOSAL_STATE_LABELS,
  formatDuration,
} from "@/lib/governor-data";
import { truncateAddress, formatAsset, formatBps } from "@/lib/contracts";

interface ProposalHistoryProps {
  proposals: ProposalData[];
  assetDecimals: number;
  assetSymbol: string;
  addressNames?: Record<string, string>;
  /** Block-explorer base URL for receipt links (e.g. https://basescan.org). */
  explorerUrl?: string;
  /** Map of proposalId → { executeTx?, settleTx? } from the activity feed. */
  receipts?: Record<string, { executeTx?: string; settleTx?: string }>;
}

function StateBadge({ state, pnl }: { state: ProposalState; pnl?: bigint }) {
  let bg: string;
  let color: string;

  switch (state) {
    case ProposalState.Settled:
      if (pnl !== undefined && pnl > 0n) {
        bg = "rgba(46, 230, 166, 0.2)";
        color = "var(--color-accent)";
      } else if (pnl !== undefined && pnl < 0n) {
        bg = "rgba(255, 77, 77, 0.2)";
        color = "#ff4d4d";
      } else {
        bg = "rgba(255, 255, 255, 0.1)";
        color = "rgba(255,255,255,0.5)";
      }
      break;
    case ProposalState.Pending:
    case ProposalState.Approved:
      bg = "rgba(59, 130, 246, 0.2)";
      color = "#3b82f6";
      break;
    case ProposalState.Executed:
      bg = "rgba(251, 191, 36, 0.2)";
      color = "#fbbf24";
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
        fontFamily: "var(--font-plus-jakarta), sans-serif",
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

function formatPnL(
  pnl: bigint,
  decimals: number,
  symbol: string,
): { text: string; color: string } {
  const isUSD = symbol === "USDC" || symbol === "USDT";
  const abs = pnl < 0n ? -pnl : pnl;
  const formatted = formatAsset(abs, decimals, isUSD ? "USD" : undefined);
  const display = isUSD ? formatted : `${formatted} ${symbol}`;
  if (pnl > 0n) return { text: `+${display}`, color: "var(--color-accent)" };
  if (pnl < 0n) return { text: `-${display}`, color: "#ff4d4d" };
  return { text: display, color: "rgba(255,255,255,0.5)" };
}

function formatCapital(
  raw: bigint,
  decimals: number,
  symbol: string,
): string {
  const isUSD = symbol === "USDC" || symbol === "USDT";
  const formatted = formatAsset(raw, decimals, isUSD ? "USD" : undefined);
  return isUSD ? formatted : `${formatted} ${symbol}`;
}

export default function ProposalHistory({
  proposals,
  assetDecimals,
  assetSymbol,
  addressNames,
  explorerUrl,
  receipts,
}: ProposalHistoryProps) {
  // Governor returns proposals in ascending id order (oldest → newest).
  // For a history view users expect the reverse — latest activity at the
  // top. Sort by id desc without mutating the caller's array.
  const ordered = [...proposals].sort((a, b) =>
    b.id > a.id ? 1 : b.id < a.id ? -1 : 0,
  );

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Proposal History</span>
        {/* <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "9px" }}>
          {proposals.length} TOTAL
        </span> */}
      </div>

      {ordered.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "2rem 0",
            color: "rgba(255,255,255,0.55)",
            fontFamily: "var(--font-plus-jakarta), sans-serif",
            fontSize: "12px",
          }}
        >
          No proposals yet
        </div>
      ) : (
        <table className="log-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">State</th>
              <th scope="col">Agent</th>
              <th scope="col">Capital</th>
              <th scope="col">P&L</th>
              <th scope="col">Fee</th>
              <th scope="col">Duration</th>
              {explorerUrl && <th scope="col">Receipt</th>}
            </tr>
          </thead>
          <tbody>
            {proposals.map((p) => {
              const pnlDisplay = p.pnl !== undefined
                ? formatPnL(p.pnl, assetDecimals, assetSymbol)
                : null;
              const r = receipts?.[p.id.toString()];

              return (
                <tr key={p.id.toString()}>
                  <td>{p.id.toString()}</td>
                  <td>
                    <StateBadge state={p.computedState} pnl={p.pnl} />
                  </td>
                  <td>{addressNames?.[p.proposer.toLowerCase()] || truncateAddress(p.proposer)}</td>
                  <td>
                    {p.capitalSnapshot > 0n
                      ? formatCapital(p.capitalSnapshot, assetDecimals, assetSymbol)
                      : "\u2014"}
                  </td>
                  <td
                    style={{
                      color: pnlDisplay?.color ?? "rgba(255,255,255,0.55)",
                      fontWeight: pnlDisplay ? 600 : 400,
                    }}
                  >
                    {pnlDisplay?.text ?? "\u2014"}
                  </td>
                  <td>{formatBps(p.performanceFeeBps)}</td>
                  <td>{formatDuration(p.strategyDuration)}</td>
                  {explorerUrl && (
                    <td style={{ whiteSpace: "nowrap" }}>
                      {r?.settleTx ? (
                        <a
                          href={`${explorerUrl}/tx/${r.settleTx}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View settlement transaction"
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "10px",
                            color: "var(--color-accent)",
                            textDecoration: "underline",
                          }}
                        >
                          settle ↗
                        </a>
                      ) : r?.executeTx ? (
                        <a
                          href={`${explorerUrl}/tx/${r.executeTx}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="View execution transaction"
                          style={{
                            fontFamily: "var(--font-mono)",
                            fontSize: "10px",
                            color: "rgba(255,255,255,0.45)",
                            textDecoration: "underline",
                          }}
                        >
                          exec ↗
                        </a>
                      ) : (
                        <span style={{ color: "rgba(255,255,255,0.2)", fontSize: "10px" }}>—</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
