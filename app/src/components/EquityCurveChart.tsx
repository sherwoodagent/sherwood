"use client";

/**
 * EquityCurveChart — TVL over time with a time-window selector.
 *
 * The server passes the full available curve (typically 7D resolution from
 * the subgraph). We slice client-side for shorter windows.
 *
 * NOTE: An earlier version included a USDC-lending "benchmark" overlay.
 * It was removed because (a) it's misleading for non-stablecoin vaults,
 * (b) without a live oracle the line is an idealized straight ramp that
 * makes early-stage / flat vaults look uniformly bad, and (c) we don't
 * yet have a real lending-rate data feed to honestly source it.
 */

import { useRef, useEffect, useState, useMemo } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
} from "chart.js";
import { Line } from "react-chartjs-2";
import { Tabs } from "@/components/ui/Tabs";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
);

type WindowId = "7D" | "30D" | "90D" | "ALL";

interface EquityCurveChartProps {
  data: number[];
  hwm: string;
}

const WINDOWS: { id: WindowId; label: string; days: number | null }[] = [
  { id: "7D", label: "7D", days: 7 },
  { id: "30D", label: "30D", days: 30 },
  { id: "90D", label: "90D", days: 90 },
  { id: "ALL", label: "ALL", days: null },
];

export default function EquityCurveChart({
  data: rawData,
  hwm,
}: EquityCurveChartProps) {
  const [windowId, setWindowId] = useState<WindowId>("7D");

  // Slice data to the selected window. If we don't have enough points,
  // fall back to whatever we have.
  const windowData = useMemo(() => {
    if (!rawData.length) return [0, 0];
    const win = WINDOWS.find((w) => w.id === windowId);
    const days = win?.days ?? rawData.length;
    const slice = rawData.slice(-days);
    return slice.length < 2 ? [slice[0] ?? 0, slice[0] ?? 0] : slice;
  }, [rawData, windowId]);

  const chartRef = useRef<ChartJS<"line">>(null);
  const [gradient, setGradient] = useState<CanvasGradient | string>(
    "rgba(46, 230, 166, 0.1)",
  );

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const ctx = chart.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, 300);
    g.addColorStop(0, "rgba(46, 230, 166, 0.15)");
    g.addColorStop(1, "rgba(46, 230, 166, 0)");
    setGradient(g);
  }, []);

  const labels = Array.from({ length: windowData.length }, (_, i) => i + 1);

  const datasets = [
    {
      label: "Vault NAV",
      data: windowData,
      borderColor: "#2EE6A6",
      borderWidth: 2,
      fill: true,
      backgroundColor: gradient,
      tension: 0.4,
      pointRadius: 0,
    },
  ];

  return (
    <div className="chart-container">
      <div className="panel-title font-[family-name:var(--font-plus-jakarta)]">
        <span>Equity Curve</span>
        <span style={{ color: "var(--color-accent)" }}>HWM: {hwm}</span>
      </div>

      <div style={{ margin: "0.5rem 0 1rem" }}>
        <Tabs
          items={WINDOWS.map((w) => ({ id: w.id, label: w.label }))}
          active={windowId}
          onChange={setWindowId}
          ariaLabel="Chart time window"
        />
      </div>

      <div style={{ height: "280px", width: "100%" }}>
        <Line
          ref={chartRef}
          data={{ labels, datasets }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                enabled: true,
                callbacks: {
                  label: (ctx) => {
                    const v = ctx.parsed?.y ?? 0;
                    const prefix = ctx.dataset.label ? `${ctx.dataset.label}: ` : "";
                    if (v === 0) return `${prefix}0`;
                    if (Math.abs(v) < 0.01) return `${prefix}${v.toPrecision(4)}`;
                    return `${prefix}${v.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
                  },
                },
              },
            },
            scales: {
              x: { display: false },
              y: {
                grid: { color: "rgba(255,255,255,0.05)" },
                ticks: {
                  callback: (value) => {
                    const v = Number(value);
                    if (v === 0) return "0";
                    if (Math.abs(v) < 0.01) return v.toPrecision(4);
                    return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
                  },
                  color: "rgba(255,255,255,0.55)",
                  font: { size: 10, family: "Plus Jakarta Sans" },
                },
              },
            },
          }}
        />
      </div>
    </div>
  );
}
