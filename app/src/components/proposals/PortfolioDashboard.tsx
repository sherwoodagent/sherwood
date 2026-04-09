"use client";

import { useEffect, useState, useRef, memo } from "react";
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
} from "chart.js";
import { Doughnut } from "react-chartjs-2";
import { fetchPricesFromApi, type TokenPrice } from "@/lib/price-quote";
import Image from "next/image";
import type { Address } from "viem";

ChartJS.register(ArcElement, Tooltip);

const PALETTE = [
  "#2EE6A6", "#3B82F6", "#F59E0B", "#EF4444", "#8B5CF6",
  "#EC4899", "#14B8A6", "#F97316", "#6366F1", "#84CC16",
];

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

function dimColor(hex: string, opacity: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

// ── Sub-components (memoized to avoid re-renders) ──

interface DoughnutProps {
  weights: number[];
  labels: string[];
  hoveredIndex: number | null;
  onHover: (index: number | null) => void;
}

const PortfolioDoughnut = memo(function PortfolioDoughnut({
  weights,
  labels,
  hoveredIndex,
  onHover,
}: DoughnutProps) {
  const chartRef = useRef<ChartJS<"doughnut">>(null);

  const borderColors = weights.map((_, i) => {
    const color = PALETTE[i % PALETTE.length];
    if (hoveredIndex === null) return color;
    return i === hoveredIndex ? color : dimColor(color, 0.2);
  });

  return (
    <div
      style={{ width: "56px", height: "56px", flexShrink: 0 }}
      onMouseLeave={() => onHover(null)}
    >
      <Doughnut
        ref={chartRef}
        data={{
          labels,
          datasets: [{
            data: weights,
            backgroundColor: "transparent",
            borderColor: borderColors,
            borderWidth: 3,
            hoverOffset: 0,
          }],
        }}
        options={{
          responsive: true,
          maintainAspectRatio: true,
          cutout: "72%",
          animation: { duration: 0 },
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          onHover: (_event: unknown, elements: { index: number }[]) => {
            onHover(elements.length > 0 ? elements[0].index : null);
          },
        }}
      />
    </div>
  );
});

interface TickerItemData {
  token: Address;
  symbol: string;
  logo: string | null;
  marketCap: number | null;
  delta: number;
  hasPrices: boolean;
  color: string;
  value: number;
}

interface TickerStripProps {
  items: TickerItemData[];
  hoveredIndex: number | null;
}

const TickerStrip = memo(function TickerStrip({ items, hoveredIndex }: TickerStripProps) {
  return (
    <div className="ticker-strip-horizontal">
      {items.map((item, i) => {
        const dimmed = hoveredIndex !== null && hoveredIndex !== i;
        return (
          <div
            key={item.token}
            className="ticker-item"
            style={{ opacity: dimmed ? 0.25 : 1, transition: "opacity 0.15s ease" }}
          >
            <div className="ticker-header">
              <span className="ticker-logo-ring" style={{ borderColor: item.color }}>
                {item.logo ? (
                  <Image src={item.logo} alt={item.symbol} width={14} height={14} unoptimized style={{ borderRadius: "50%", display: "block" }} />
                ) : (
                  <span style={{ width: 14, height: 14, borderRadius: "50%", background: item.color, display: "block" }} />
                )}
              </span>
              <span className="ticker-symbol">{item.symbol}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
              <span className="ticker-mcap">
                {item.marketCap ? formatMarketCap(item.marketCap) : "—"}
              </span>
              {item.hasPrices && (
                <span className={`ticker-delta ${item.delta >= 0 ? "delta-positive" : "delta-negative"}`}>
                  {formatDelta(item.delta)}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
});

// ── Main component (owns state) ──

export default function PortfolioDashboard({
  allocations,
  totalInvested,
  assetSymbol,
  assetAddress,
  assetDecimals,
  chainId,
}: PortfolioDashboardProps) {
  const [prices, setPrices] = useState<Map<string, TokenPrice>>(new Map());
  const [loading, setLoading] = useState(true);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const tokens = allocations.map((a) => ({
        token: a.token,
        decimals: a.decimals,
        feeTier: a.feeTier,
      }));
      const result = await fetchPricesFromApi(chainId, tokens, assetAddress, assetDecimals);
      if (!cancelled) {
        setPrices(result);
        setLoading(false);
      }
    };
    run();
    const interval = setInterval(run, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [allocations, chainId, assetAddress, assetDecimals]);

  // Compute portfolio value (no mutable reassignment — use reduce)
  const totalInvestedNum = parseFloat(totalInvested.replace(/,/g, ""));

  const tickerItems: TickerItemData[] = allocations.map((a, i) => {
    const tp = prices.get(a.token.toLowerCase());
    const tokenAmt = parseFloat(a.tokenAmount);
    const invested = parseFloat(a.investedAmount);
    const price = tp?.price ?? 0;
    const value = tokenAmt * price;
    const delta = invested > 0 ? ((value - invested) / invested) * 100 : 0;
    return {
      token: a.token,
      symbol: a.symbol,
      logo: a.logo,
      marketCap: a.marketCap,
      delta,
      hasPrices: !loading && price > 0,
      color: PALETTE[i % PALETTE.length],
      value,
    };
  });

  const portfolioValue = tickerItems.reduce((sum, t) => sum + t.value, 0);
  const overallDelta = totalInvestedNum > 0
    ? ((portfolioValue - totalInvestedNum) / totalInvestedNum) * 100
    : 0;

  return (
    <div className="portfolio-dashboard-compact">
      <PortfolioDoughnut
        weights={allocations.map((a) => a.weightPct)}
        labels={allocations.map((a) => a.symbol)}
        hoveredIndex={hoveredIndex}
        onHover={setHoveredIndex}
      />

      <div className="portfolio-value-inline">
        <span className="portfolio-value-amount">
          {loading ? "—" : `${portfolioValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${assetSymbol}`}
        </span>
        {!loading && (
          <span className={`portfolio-value-delta ${overallDelta >= 0 ? "delta-positive" : "delta-negative"}`}>
            {formatDelta(overallDelta)}
          </span>
        )}
      </div>

      <TickerStrip items={tickerItems} hoveredIndex={hoveredIndex} />
    </div>
  );
}
