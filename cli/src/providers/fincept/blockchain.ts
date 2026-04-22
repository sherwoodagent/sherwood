/**
 * Blockchain.com BTC network stats wrapper.
 *
 * Fetches hash rate, difficulty, mempool size, miner revenue, market price,
 * and transaction count via the Fincept Python bridge.
 */

import { callFincept } from "./bridge.js";

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export interface BtcNetworkStats {
  hashRate: number;
  difficulty: number;
  mempoolSize: number;
  minerRevenueBtc: number;
  marketPriceUsd: number;
  transactionCount: number;
}

interface RawStats {
  hash_rate: number;
  difficulty: number;
  mempool_size: number;
  miners_revenue_btc: number;
  market_price_usd: number;
  n_tx: number;
}

/**
 * Fetch BTC network statistics from Blockchain.com via the Fincept bridge.
 * Returns null if the script fails or returns invalid data.
 */
export async function getBtcNetworkStats(): Promise<BtcNetworkStats | null> {
  const result = await callFincept<RawStats>(
    "blockchain_com_data.py",
    ["stats"],
    30_000,
    CACHE_TTL,
  );

  if (!result.ok || !result.data) {
    return null;
  }

  const raw = result.data;
  return {
    hashRate: raw.hash_rate ?? 0,
    difficulty: raw.difficulty ?? 0,
    mempoolSize: raw.mempool_size ?? 0,
    minerRevenueBtc: raw.miners_revenue_btc ?? 0,
    marketPriceUsd: raw.market_price_usd ?? 0,
    transactionCount: raw.n_tx ?? 0,
  };
}
