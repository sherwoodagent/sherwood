/**
 * Shared formatting helpers for CLI output.
 */

/** Compact duration: "3d", "2.5h", "15m", "30s" */
export function formatDurationShort(seconds: bigint): string {
  const s = Number(seconds);
  if (s >= 86400) return `${(s / 86400).toFixed(s % 86400 === 0 ? 0 : 1)}d`;
  if (s >= 3600) return `${(s / 3600).toFixed(s % 3600 === 0 ? 0 : 1)}h`;
  if (s >= 60) return `${(s / 60).toFixed(0)}m`;
  return `${s}s`;
}

/** Verbose duration: "3 days", "2.5 hours", "15 min", "30s" */
export function formatDurationLong(seconds: bigint): string {
  const s = Number(seconds);
  if (s >= 86400) return `${(s / 86400).toFixed(s % 86400 === 0 ? 0 : 1)} day${s >= 172800 ? "s" : ""}`;
  if (s >= 3600) return `${(s / 3600).toFixed(s % 3600 === 0 ? 0 : 1)} hour${s >= 7200 ? "s" : ""}`;
  if (s >= 60) return `${(s / 60).toFixed(0)} min`;
  return `${s}s`;
}

/** Format raw 6-decimal share amounts to human-readable (e.g. 124000000000 → "124,000") */
export function formatShares(raw: bigint): string {
  const num = Number(raw) / 1e6;
  return num.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** Format USDC amount (6 decimals) to human-readable (e.g. 50000000000 → "$50,000.00") */
export function formatUSDC(raw: bigint): string {
  const num = Number(raw) / 1e6;
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Validate string as BigInt, throw user-friendly error */
export function parseBigIntArg(value: string, name: string): bigint {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Invalid ${name}: "${value}" is not a valid integer`);
  }
  return BigInt(value);
}
