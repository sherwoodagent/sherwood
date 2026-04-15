/**
 * RiskMetricsPanel — small read-only dashboard derived from the same
 * equity-curve series the chart uses. No extra data fetches.
 */

import { computeRiskMetrics } from "@/lib/risk-metrics";

interface Props {
  series: number[];
  assetSymbol: string;
  /** Show as USD vs token. Defaults: true for USDC/USDT. */
  isUsd?: boolean;
}

export default function RiskMetricsPanel({ series, assetSymbol, isUsd }: Props) {
  const metrics = computeRiskMetrics(series);
  const showUsd = isUsd ?? (assetSymbol === "USDC" || assetSymbol === "USDT");

  const cells: { label: string; value: string; color?: string; hint?: string }[] = [
    {
      label: "Total return",
      value:
        metrics.totalReturnPct === null
          ? "—"
          : `${metrics.totalReturnPct >= 0 ? "+" : ""}${metrics.totalReturnPct.toFixed(2)}%`,
      color:
        metrics.totalReturnPct === null
          ? undefined
          : metrics.totalReturnPct > 0
            ? "var(--color-accent)"
            : metrics.totalReturnPct < 0
              ? "#ff4d4d"
              : undefined,
      hint: "Change from start of available history to now.",
    },
    {
      label: "Max drawdown",
      value:
        metrics.maxDrawdownPct === null
          ? "—"
          : `-${metrics.maxDrawdownPct.toFixed(2)}%`,
      color: metrics.maxDrawdownPct && metrics.maxDrawdownPct > 0 ? "#ff4d4d" : undefined,
      hint: "Largest peak-to-trough drop in the series.",
    },
    {
      label: "Days since HWM",
      value:
        metrics.daysSinceHWM === null
          ? "—"
          : metrics.daysSinceHWM === 0
            ? "Today"
            : `${metrics.daysSinceHWM}d`,
      hint: "Days since the high-water mark was last touched.",
    },
    {
      label: showUsd ? "Current TVL" : `Current (${assetSymbol})`,
      value:
        metrics.current === null
          ? "—"
          : showUsd
            ? metrics.current.toLocaleString("en-US", {
                style: "currency",
                currency: "USD",
                maximumFractionDigits: 0,
              })
            : `${metrics.current.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${assetSymbol}`,
    },
  ];

  return (
    <div className="panel">
      <div className="panel-title">
        <span>Risk &amp; Performance</span>
        <span style={{ color: "var(--color-fg-secondary)", fontSize: "10px" }}>
          DERIVED
        </span>
      </div>

      <div className="metrics-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        {cells.map((c) => (
          <div key={c.label} className="sh-card--metric" title={c.hint}>
            <div className="metric-label">{c.label}</div>
            <div
              className="metric-val"
              style={{ color: c.color, fontSize: "1.1rem" }}
            >
              {c.value}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: "0.75rem",
          fontSize: "11px",
          color: "var(--color-fg-secondary)",
          lineHeight: 1.5,
        }}
      >
        Computed from the equity curve. Excludes mid-strategy unrealized P&amp;L.
      </div>
    </div>
  );
}
