import { formatUnits, type Address } from "viem";
import { formatBps, shareDecimals } from "@/lib/contracts";
import RedemptionLockStatus from "@/components/RedemptionLockStatus";
import { Term } from "@/components/ui/Glossary";
import { Tooltip } from "@/components/ui/Tooltip";

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
        <div className="sh-card--metric">
          <div className="metric-label">Deposits</div>
          {/* The on-chain `openDeposits` flag is the *permission policy*
              (anyone vs. whitelist), not whether deposits are accepted right
              now. Combine it with paused + redemptionsLocked so users get a
              true "can I deposit?" answer. */}
          {paused ? (
            <Tooltip content="Vault owner has paused all deposits and withdrawals.">
              <div className="metric-val" style={{ color: "#ff4d4d" }}>
                PAUSED
              </div>
            </Tooltip>
          ) : redemptionsLocked ? (
            <Tooltip content="Deposits are blocked while a strategy is executing — they would mint inflated shares against drained vault assets. Resumes when the strategy settles.">
              <div className="metric-val" style={{ color: "#ff4d4d" }}>
                LOCKED
              </div>
            </Tooltip>
          ) : openDeposits ? (
            <Tooltip content="Anyone can deposit — no whitelist.">
              <div className="metric-val" style={{ color: "var(--color-accent)" }}>
                OPEN
              </div>
            </Tooltip>
          ) : (
            <Tooltip content="Only addresses approved by the vault owner can deposit.">
              <div className="metric-val" style={{ color: "var(--color-fg-secondary)" }}>
                WHITELIST
              </div>
            </Tooltip>
          )}
        </div>
        <div className="sh-card--metric">
          <div className="metric-label">Management Fee</div>
          <div className="metric-val">{formatBps(managementFeeBps)}</div>
        </div>
        <div className="sh-card--metric">
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
        <div className="sh-card--metric">
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
            {parseFloat(formatUnits(totalSupply, shareDecimals(assetDecimals))).toLocaleString("en-US", {
              maximumFractionDigits: 2,
            })}
          </span>
        </div>
      </div>
    </div>
  );
}
