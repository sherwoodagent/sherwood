"use client";

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
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
import { quoteAllTokenPrices, type TokenPrice } from "@/lib/price-quote";
import type { Address } from "viem";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip
);

const PALETTE = [
  "#2EE6A6", "#3B82F6", "#F59E0B", "#EF4444", "#8B5CF6",
  "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16",
];

const TIMEFRAMES = ["15m", "1h", "4h", "1d"] as const;

interface Allocation {
  token: Address;
  symbol: string;
  decimals: number;
  weightPct: number;
  tokenAmount: string;
  investedAmount: string;
  feeTier: number;
  logo: string | null;
  marketCap: number | null;
}

interface PortfolioDashboardProps {
  allocations: Allocation[];
  totalInvested: string;
  assetSymbol: string;
  assetAddress: Address;
  assetDecimals: number;
  chainId: number;
  equityCurve: number[];
}

function formatMarketCap(mcap: number): string {
  if (mcap >= 1_000_000_000) return `$${(mcap / 1_000_000_000).toFixed(1)}B`;
  if (mcap >= 1_000_000) return `$${(mcap / 1_000_000).toFixed(1)}M`;
  if (mcap >= 1_000) return `$${(mcap / 1_000).toFixed(1)}K`;
  return `$${mcap.toFixed(0)}`;
}

function formatDelta(delta: number): string {
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(2)}%`;
}

/**
 * Subsample an equity curve array to fit the selected timeframe granularity.
 * Since the source data is 7 daily points, shorter timeframes show fewer points.
 */
function sampleCurve(data: number[], timeframe: typeof TIMEFRAMES[number]): number[] {
  if (data.length <= 1) return data;
  switch (timeframe) {
    case "15m": return data.slice(-2); // last 2 points
    case "1h": return data.slice(-3);
    case "4h": return data.slice(-5);
    case "1d":
    default: return data;
  }
}

export default function PortfolioDashboard({
  allocations,
  totalInvested,
  assetSymbol,
  assetAddress,
  assetDecimals,
  chainId,
  equityCurve,
}: PortfolioDashboardProps) {
  const chartRef = useRef<ChartJS<"line">>(null);
  const [gradient, setGradient] = useState<CanvasGradient | string>(
    "rgba(46, 230, 166, 0.1)"
  );
  const [prices, setPrices] = useState<Map<string, TokenPrice>>(new Map());
  const [loading, setLoading] = useState(true);
  const [selectedTf, setSelectedTf] = useState<typeof TIMEFRAMES[number]>("1d");

  // Build gradient on mount
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const ctx = chart.ctx;
    const g = ctx.createLinearGradient(0, 0, 0, 280);
    g.addColorStop(0, "rgba(46, 230, 166, 0.15)");
    g.addColorStop(1, "rgba(46, 230, 166, 0)");
    setGradient(g);
  }, []);

  // Fetch prices
  const fetchPrices = useCallback(async () => {
    const tokens = allocations.map((a) => ({
      token: a.token,
      decimals: a.decimals,
      feeTier: a.feeTier,
    }));
    const result = await quoteAllTokenPrices(chainId, tokens, assetAddress, assetDecimals);
    setPrices(result);
    setLoading(false);
  }, [allocations, chainId, assetAddress, assetDecimals]);

  useEffect(() => {
    fetchPrices();
    const interval = setInterval(fetchPrices, 30_000);
    return () => clearInterval(interval);
  }, [fetchPrices]);

  // Compute portfolio value
  const totalInvestedNum = parseFloat(totalInvested.replace(/,/g, ""));
  let portfolioValue = 0;
  const tokenValues: { symbol: string; value: number; invested: number; price: number }[] = [];

  for (const a of allocations) {
    const tp = prices.get(a.token.toLowerCase());
    const tokenAmt = parseFloat(a.tokenAmount);
    const invested = parseFloat(a.investedAmount);
    const price = tp?.price ?? 0;
    const value = tokenAmt * price;
    portfolioValue += value;
    tokenValues.push({ symbol: a.symbol, value, invested, price });
  }

  const overallDelta = totalInvestedNum > 0
    ? ((portfolioValue - totalInvestedNum) / totalInvestedNum) * 100
    : 0;

  // Subsample curve for selected timeframe
  const chartData = useMemo(() => sampleCurve(equityCurve, selectedTf), [equityCurve, selectedTf]);
  const labels = Array.from({ length: chartData.length }, (_, i) => i + 1);

  return (
    <div className="portfolio-dashboard">
      {/* Left: chart area */}
      <div>
        {/* Value header */}
        <div className="portfolio-value-header">
          <span className="value">
            {loading ? "—" : `${portfolioValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${assetSymbol}`}
          </span>
          {!loading && (
            <span className={`delta ${overallDelta >= 0 ? "delta-positive" : "delta-negative"}`}>
              {formatDelta(overallDelta)}
            </span>
          )}
        </div>

        {/* Time selectors */}
        <div className="time-selector">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf}
              className={tf === selectedTf ? "active" : ""}
              onClick={() => setSelectedTf(tf)}
            >
              {tf}
            </button>
          ))}
        </div>

        {/* Equity curve chart */}
        <div style={{ height: "280px", width: "100%" }}>
          <Line
            ref={chartRef}
            data={{
              labels,
              datasets: [
                {
                  label: "Portfolio Value",
                  data: chartData,
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
                      return `${v.toFixed(2)} ${assetSymbol}`;
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
                      return v.toFixed(2);
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

      {/* Right: ticker strip */}
      <div className="ticker-strip">
        {allocations.map((a, i) => (
          <div key={a.token} className="ticker-item">
            <div className="ticker-header">
              {a.logo ? (
                <img
                  src={a.logo}
                  alt={a.symbol}
                  width={20}
                  height={20}
                  style={{ borderRadius: "50%", flexShrink: 0 }}
                />
              ) : (
                <span className="dot" style={{ width: 12, height: 12, borderRadius: "50%", background: PALETTE[i % PALETTE.length], display: "inline-block", flexShrink: 0 }} />
              )}
              <span className="ticker-symbol">{a.symbol}</span>
              <span className="ticker-weight">{a.weightPct.toFixed(0)}%</span>
            </div>
            <span className="ticker-mcap">
              {a.marketCap ? `MCap ${formatMarketCap(a.marketCap)}` : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
