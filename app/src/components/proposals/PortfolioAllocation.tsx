"use client";

import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
} from "chart.js";
import { Doughnut } from "react-chartjs-2";

ChartJS.register(ArcElement, Tooltip);

// ── Color palette for chart segments ────────────────────────

const PALETTE = [
  "#2EE6A6", // accent green
  "#3b82f6", // blue
  "#eab308", // yellow
  "#ec4899", // pink
  "#8b5cf6", // purple
  "#f97316", // orange
  "#14b8a6", // teal
  "#f43f5e", // rose
  "#6366f1", // indigo
  "#84cc16", // lime
];

// ── Types ───────────────────────────────────────────────────

interface AllocationDisplay {
  symbol: string;
  weightPct: number;
}

interface PortfolioAllocationProps {
  allocations: AllocationDisplay[];
  totalAmount: string;
  assetSymbol: string;
}

// ── Component ───────────────────────────────────────────────

export default function PortfolioAllocation({
  allocations,
  totalAmount,
  assetSymbol,
}: PortfolioAllocationProps) {
  if (allocations.length === 0) return null;

  const chartData = {
    labels: allocations.map((a) => a.symbol),
    datasets: [
      {
        data: allocations.map((a) => a.weightPct),
        backgroundColor: allocations.map(
          (_, i) => PALETTE[i % PALETTE.length],
        ),
        borderWidth: 0,
        hoverOffset: 4,
      },
    ],
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: true,
    cutout: "65%",
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: "rgba(0,0,0,0.8)",
        titleFont: { family: "var(--font-plus-jakarta), sans-serif", size: 12 },
        bodyFont: { family: "var(--font-plus-jakarta), sans-serif", size: 12 },
        callbacks: {
          label: (ctx: { label: string; parsed: number }) =>
            `${ctx.label}: ${ctx.parsed.toFixed(1)}%`,
        },
      },
    },
  };

  return (
    <div style={{ marginTop: "1rem" }}>
      <div
        style={{
          fontSize: "10px",
          fontFamily: "var(--font-plus-jakarta), sans-serif",
          color: "rgba(255,255,255,0.4)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: "0.75rem",
        }}
      >
        Portfolio ({allocations.length} tokens)
      </div>

      <div
        style={{
          display: "flex",
          gap: "1.5rem",
          alignItems: "center",
        }}
      >
        {/* Donut chart */}
        <div style={{ width: "120px", height: "120px", flexShrink: 0 }}>
          <Doughnut data={chartData} options={chartOptions} />
        </div>

        {/* Token list */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {allocations.map((a, i) => (
            <div
              key={a.symbol}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
              }}
            >
              {/* Colored dot */}
              <div
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  backgroundColor: PALETTE[i % PALETTE.length],
                  flexShrink: 0,
                }}
              />
              {/* Symbol */}
              <span
                style={{
                  fontSize: "13px",
                  color: "#fff",
                  fontWeight: 500,
                  flex: 1,
                }}
              >
                {a.symbol}
              </span>
              {/* Weight */}
              <span
                style={{
                  fontSize: "13px",
                  color: "rgba(255,255,255,0.6)",
                  fontFamily: "var(--font-plus-jakarta), sans-serif",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {a.weightPct.toFixed(1)}%
              </span>
            </div>
          ))}

          {/* Total deployed */}
          <div
            style={{
              borderTop: "1px solid rgba(255,255,255,0.08)",
              paddingTop: "0.5rem",
              marginTop: "0.25rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span
              style={{
                fontSize: "11px",
                color: "rgba(255,255,255,0.6)",
                fontFamily: "var(--font-plus-jakarta), sans-serif",
              }}
            >
              Deployed
            </span>
            <span
              style={{
                fontSize: "13px",
                color: "var(--color-accent)",
                fontWeight: 500,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {totalAmount} {assetSymbol}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
