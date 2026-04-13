import { formatUnits, type Address } from "viem";
import { formatBps } from "@/lib/contracts";
import RedemptionLockStatus from "@/components/RedemptionLockStatus";
import { Term } from "@/components/ui/Glossary";

interface VaultOverviewProps {
  openDeposits: boolean;
  totalSupply: bigint;
  paused: boolean;
  redemptionsLocked: boolean;
  managementFeeBps: bigint;
  assetDecimals: number;
  vault?: Address;
  chainId?: number;
}

export default function VaultOverview({
  openDeposits,
  totalSupply,
  paused,
  redemptionsLocked,
  managementFeeBps,
  assetDecimals,
  vault,
  chainId,
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
          <div className="metric-label">
            <Term k="redemptions-locked">Redemptions</Term>
          </div>
          <div className="metric-val" style={{ fontSize: "0.9rem" }}>
            {vault && chainId ? (
              <RedemptionLockStatus vault={vault} chainId={chainId} initialLocked={redemptionsLocked} />
            ) : (
              <span style={{ color: redemptionsLocked ? "#ff4d4d" : "var(--color-accent)" }}>
                {redemptionsLocked ? "LOCKED" : "OPEN"}
              </span>
            )}
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
            {parseFloat(formatUnits(totalSupply, assetDecimals * 2)).toLocaleString("en-US", {
              maximumFractionDigits: 2,
            })}
          </span>
        </div>
      </div>
    </div>
  );
}
