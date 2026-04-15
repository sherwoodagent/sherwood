/**
 * Risk metrics computed from a TVL/equity-curve series.
 *
 * Honest scope: these metrics are derived from the same data we already
 * fetch for the chart. They do NOT capture intra-day moves or position
 * risk inside an active strategy — for those we'd need a feed of unrealized
 * P&L per executed proposal, which we don't have yet.
 */

export interface RiskMetrics {
  totalReturnPct: number | null;
  /** Largest peak-to-trough drop expressed as a positive percentage. */
  maxDrawdownPct: number | null;
  /** Days since the high-water mark was last touched. */
  daysSinceHWM: number | null;
  /** Most recent value. */
  current: number | null;
  /** High-water mark over the series. */
  hwm: number | null;
}

const EMPTY: RiskMetrics = {
  totalReturnPct: null,
  maxDrawdownPct: null,
  daysSinceHWM: null,
  current: null,
  hwm: null,
};

export function computeRiskMetrics(series: number[]): RiskMetrics {
  if (!series.length) return EMPTY;
  if (series.length === 1) {
    const v = series[0];
    return {
      totalReturnPct: 0,
      maxDrawdownPct: 0,
      daysSinceHWM: 0,
      current: v,
      hwm: v,
    };
  }

  const start = series[0];
  const current = series[series.length - 1];

  let peak = series[0];
  let maxDrawdown = 0; // expressed as a positive fraction
  let hwmIndex = 0;

  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v > peak) {
      peak = v;
      hwmIndex = i;
    } else if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }

  // If the series starts at zero (e.g. chart window predates the first
  // deposit), a percentage return from zero is undefined. Returning 0%
  // would be misleading — surface null so the UI renders "—" instead.
  const totalReturnPct = start > 0 ? ((current - start) / start) * 100 : null;
  // Series buckets are daily samples in fetchEquityCurve — index distance
  // from the HWM bucket is therefore "days since HWM".
  const daysSinceHWM = series.length - 1 - hwmIndex;

  return {
    totalReturnPct,
    maxDrawdownPct: maxDrawdown * 100,
    daysSinceHWM,
    current,
    hwm: peak,
  };
}
