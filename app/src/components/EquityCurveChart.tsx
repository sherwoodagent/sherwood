"use client";

import { useRef, useEffect, useState } from "react";
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

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip
);

interface EquityCurveChartProps {
  data: number[];
  hwm: string;
}

export default function EquityCurveChart({ data: rawData, hwm }: EquityCurveChartProps) {
  // Chart.js needs at least 2 points to draw a line
  const data = rawData.length < 2 ? [rawData[0] ?? 0, rawData[0] ?? 0] : rawData;

  const chartRef = useRef<ChartJS<"line">>(null);
  const [gradient, setGradient] = useState<CanvasGradient | string>(
    "rgba(46, 230, 166, 0.1)"
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

  const labels = Array.from({ length: data.length }, (_, i) => i + 1);

  return (
    <div className="chart-container">
      <div className="panel-title font-[family-name:var(--font-plus-jakarta)]">
        <span>Equity Curve (7D)</span>
        <span style={{ color: "var(--color-accent)" }}>HWM: {hwm}</span>
      </div>
      <div style={{ height: "280px", width: "100%" }}>
        <Line
          ref={chartRef}
          data={{
            labels,
            datasets: [
              {
                label: "Portfolio Value",
                data,
                borderColor: "#2EE6A6",
                borderWidth: 2,
                fill: true,
                backgroundColor: gradient,
                tension: 0.4,
                pointRadius: 0,
              },
            ],
          }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                enabled: true,
                callbacks: {
                  label: (ctx) => {
                    const v = ctx.parsed?.y ?? 0;
                    if (v === 0) return "0";
                    if (Math.abs(v) < 0.01) return v.toPrecision(4);
                    return v.toFixed(4);
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
                    return v.toFixed(4);
                  },
                  color: "rgba(255,255,255,0.3)",
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
