import type { SyndicateCaps } from "@/lib/syndicate-data";
import { formatUSDC, formatBps, truncateAddress } from "@/lib/contracts";
import type { Address } from "viem";

interface VaultOverviewProps {
  caps: SyndicateCaps;
  openDeposits: boolean;
  allowedTargets: Address[];
  totalSupply: bigint;
  paused: boolean;
}

export default function VaultOverview({
  caps,
  openDeposits,
  allowedTargets,
  totalSupply,
  paused,
}: VaultOverviewProps) {
  return (
    <div className="panel">
      <div className="panel-title">Vault Configuration</div>

      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-label">Max Per Tx</div>
          <div className="metric-val">{formatUSDC(caps.maxPerTx)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Max Daily Total</div>
          <div className="metric-val">{formatUSDC(caps.maxDailyTotal)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Max Borrow</div>
          <div className="metric-val">{formatBps(caps.maxBorrowRatio)}</div>
        </div>
        <div className="metric-card">
          <div className="metric-label">Open Deposits</div>
          <div
            className="metric-val"
            style={{ color: openDeposits ? "var(--color-accent)" : "#ff4d4d" }}
          >
            {openDeposits ? "YES" : "NO"}
          </div>
        </div>
      </div>

      <div className="param-list" style={{ marginTop: "1.5rem" }}>
        <div className="param-row">
          <span className="param-key">Total Shares</span>
          <span className="param-val">
            {(Number(totalSupply) / 1e6).toLocaleString()}
          </span>
        </div>
        <div className="param-row">
          <span className="param-key">Status</span>
          <span
            className="param-val"
            style={paused ? { color: "#ff4d4d" } : undefined}
          >
            {paused ? "Paused" : "Active"}
          </span>
        </div>
        <div className="param-row">
          <span className="param-key">Allowed Targets</span>
          <span className="param-val">{allowedTargets.length}</span>
        </div>
        {allowedTargets.slice(0, 5).map((t) => (
          <div className="param-row" key={t} style={{ paddingLeft: "1rem" }}>
            <span className="param-key" style={{ fontSize: "10px" }}>
              {truncateAddress(t)}
            </span>
          </div>
        ))}
        {allowedTargets.length > 5 && (
          <div className="param-row" style={{ paddingLeft: "1rem" }}>
            <span className="param-key" style={{ fontSize: "10px" }}>
              +{allowedTargets.length - 5} more
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
