/**
 * CryptoCompare candle wrapper — fallback candle source replacing CoinGecko OHLC.
 * Hyperliquid remains the primary candle source.
 */

import { callFincept } from "./bridge.js";
import type { Candle } from "../../agent/technical.js";

const OHLCV_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours

/** CoinGecko token ID → CryptoCompare symbol */
const CC_SYMBOL: Record<string, string> = {
  bitcoin: "BTC",
  ethereum: "ETH",
  solana: "SOL",
  aave: "AAVE",
  uniswap: "UNI",
  chainlink: "LINK",
  ripple: "XRP",
  dogecoin: "DOGE",
  polkadot: "DOT",
  avalanche: "AVAX",
  arbitrum: "ARB",
  hyperliquid: "HYPE",
  zcash: "ZEC",
  fartcoin: "FARTCOIN",
  pepe: "PEPE",
  cardano: "ADA",
  ethena: "ENA",
  "worldcoin-wld": "WLD",
  bittensor: "TAO",
  sui: "SUI",
  near: "NEAR",
  aptos: "APT",
  "pudgy-penguins": "PENGU",
  blur: "BLUR",
  "fetch-ai": "FET",
};

interface CCBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumefrom: number;
  volumeto: number;
}

interface CCResponse {
  ohlcv: CCBar[];
}

/**
 * Fetch hourly candles from CryptoCompare via Fincept bridge and downsample to 4h.
 * Returns null if the token is unmapped or data is insufficient.
 */
export async function getCryptoCompareCandles(
  tokenId: string,
  limit: number = 180,
): Promise<Candle[] | null> {
  const symbol = CC_SYMBOL[tokenId];
  if (!symbol) return null;

  const result = await callFincept<CCResponse>(
    "cryptocompare_data.py",
    ["hourly", symbol, "USD", String(limit * 4)],
    30_000,
    OHLCV_CACHE_TTL,
  );

  if (!result.ok || !result.data) return null;

  const bars = result.data.ohlcv;
  if (!bars || bars.length < 10) return null;

  // Downsample hourly bars to 4h candles
  const candles: Candle[] = [];
  for (let i = 0; i + 3 < bars.length; i += 4) {
    const chunk = bars.slice(i, i + 4);
    candles.push({
      timestamp: chunk[0]!.time * 1000,
      open: chunk[0]!.open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1]!.close,
      volume: chunk.reduce((sum, b) => sum + b.volumeto, 0),
    });
  }

  return candles.length > 0 ? candles : null;
}
