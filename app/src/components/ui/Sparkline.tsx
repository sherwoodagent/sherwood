"use client";

/**
 * Sparkline — tiny inline SVG line chart. Renders a series of numbers
 * into a fixed-width path. No axis, no tooltips — atmospherics only.
 */

import { useId, useMemo } from "react";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  /** Accent color for line + gradient. Defaults to Sherwood accent. */
  color?: string;
  strokeWidth?: number;
  fill?: boolean;
  ariaLabel?: string;
}

export function Sparkline({
  data,
  width = 80,
  height = 24,
  color = "#2EE6A6",
  strokeWidth = 1.25,
  fill = true,
  ariaLabel,
}: SparklineProps) {
  const id = useId();
  const { path, area, trend } = useMemo(() => buildPath(data, width, height), [data, width, height]);

  if (data.length < 2) {
    // Single-point fallback — render a dot to avoid a jarring empty area
    return (
      <svg
        width={width}
        height={height}
        aria-hidden={!ariaLabel}
        aria-label={ariaLabel}
        className="sh-spark"
        viewBox={`0 0 ${width} ${height}`}
      >
        <circle cx={width / 2} cy={height / 2} r={1.5} fill={color} opacity={0.6} />
      </svg>
    );
  }

  const trendColor = trend === "down" ? "#ff4d4d" : color;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="sh-spark"
      aria-hidden={!ariaLabel}
      aria-label={ariaLabel}
    >
      <defs>
        <linearGradient id={`grad-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={trendColor} stopOpacity="0.35" />
          <stop offset="100%" stopColor={trendColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#grad-${id})`} />}
      <path d={path} fill="none" stroke={trendColor} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function buildPath(data: number[], w: number, h: number) {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = w / (data.length - 1);
  const pad = 1.5;

  const pts = data.map((v, i) => {
    const x = i * stepX;
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y] as const;
  });

  const path = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `${path} L${w},${h} L0,${h} Z`;
  const trend = data[data.length - 1] >= data[0] ? "up" : "down";

  return { path, area, trend };
}
