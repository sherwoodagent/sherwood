import { formatBps, formatShares } from "@/lib/contracts";

interface VaultOverviewProps {
  openDeposits: boolean;
  totalSupply: bigint;
  paused: boolean;
  redemptionsLocked: boolean;
  managementFeeBps: bigint;
  assetDecimals: number;
}

export default function VaultOverview({
  openDeposits,
  totalSupply,
  paused,
  redemptionsLocked,
  managementFeeBps,
  assetDecimals,
}: VaultOverviewProps) {
  return (
    <div className="panel">
      <div className="panel-title">Vault Configuration</div>

      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-label">Open Deposits</div>
          <div
            className="metric-val"
            style={{ color: openDeposits ? "var(--color-accent)" : "#ff4d4d" }}
          >
            {openDeposits ? "YES" : "NO"}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Management Fee</div>
          <div className="metric-val">{formatBps(managementFeeBps)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Redemptions</div>
          <div
            className="metric-val"
            style={{ color: redemptionsLocked ? "#ff4d4d" : "var(--color-accent)" }}
          >
            {redemptionsLocked ? "LOCKED" : "OPEN"}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Status</div>
          <div
            className="metric-val"
            style={paused ? { color: "#ff4d4d" } : { color: "var(--color-accent)" }}
          >
            {paused ? "PAUSED" : "ACTIVE"}
          </div>
        </div>
      </div>

      <div className="param-list" style={{ marginTop: "1.5rem" }}>
        <div className="param-row">
          <span className="param-key">Total Shares</span>
          <span className="param-val">
            {formatShares(totalSupply, assetDecimals * 2)}
          </span>
        </div>
      </div>
    </div>
  );
}
