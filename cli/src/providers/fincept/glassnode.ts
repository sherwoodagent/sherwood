/**
 * Glassnode on-chain metrics wrapper.
 *
 * Fetches active addresses, NVT ratio, SOPR, and transaction count
 * via the Fincept Python bridge (glassnode_data.py).
 * Only BTC and ETH are supported.
 */

import { callFincept } from "./bridge.js";

const CACHE_TTL = 60 * 60 * 1000; // 1 hour

/** CoinGecko ID → Glassnode asset symbol. */
const ASSET_MAP: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
};

export interface GlassnodeMetrics {
  activeAddresses: number;
  activeAddressesGrowth: number;
  nvtRatio: number;
  sopr: number;
  transactionCount: number;
}

interface TimeseriesPoint {
  t: number;
  v: number;
}

/**
 * Extract the latest value from a Glassnode timeseries response.
 * Returns 0 if the array is empty.
 */
function latestValue(data: TimeseriesPoint[]): number {
  if (!data || data.length === 0) return 0;
  return data[data.length - 1]!.v;
}

/**
 * Compute growth rate: (latest - first) / first.
 * Returns 0 if the array has fewer than 2 points or first is zero.
 */
function growthRate(data: TimeseriesPoint[]): number {
  if (!data || data.length < 2) return 0;
  const first = data[0]!.v;
  const latest = data[data.length - 1]!.v;
  if (first === 0) return 0;
  return (latest - first) / first;
}

/**
 * Fetch Glassnode on-chain metrics for a token.
 *
 * @returns metrics object, or null if the token is unsupported or
 *          GLASSNODE_API_KEY is not configured.
 */
export async function getGlassnodeMetrics(
  tokenId: string,
): Promise<GlassnodeMetrics | null> {
  const asset = ASSET_MAP[tokenId];
  if (!asset) return null;
  if (!process.env.GLASSNODE_API_KEY) return null;

  const [addrRes, nvtRes, soprRes, txRes] = await Promise.all([
    callFincept<TimeseriesPoint[]>(
      "glassnode_data.py",
      ["active_addresses", asset, "7d"],
      30_000,
      CACHE_TTL,
    ),
    callFincept<TimeseriesPoint[]>(
      "glassnode_data.py",
      ["nvt", asset, "7d"],
      30_000,
      CACHE_TTL,
    ),
    callFincept<TimeseriesPoint[]>(
      "glassnode_data.py",
      ["sopr", asset, "7d"],
      30_000,
      CACHE_TTL,
    ),
    callFincept<TimeseriesPoint[]>(
      "glassnode_data.py",
      ["transactions", asset, "7d"],
      30_000,
      CACHE_TTL,
    ),
  ]);

  const addrData = addrRes.ok && addrRes.data ? addrRes.data : [];
  const nvtData = nvtRes.ok && nvtRes.data ? nvtRes.data : [];
  const soprData = soprRes.ok && soprRes.data ? soprRes.data : [];
  const txData = txRes.ok && txRes.data ? txRes.data : [];

  return {
    activeAddresses: latestValue(addrData),
    activeAddressesGrowth: growthRate(addrData),
    nvtRatio: latestValue(nvtData),
    sopr: latestValue(soprData),
    transactionCount: latestValue(txData),
  };
}
