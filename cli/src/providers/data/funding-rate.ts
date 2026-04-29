/**
 * Funding rate provider — fetches perpetual futures funding rates from Binance.
 * Free public API, no authentication required.
 * Rate limit: 2400 req/min (generous).
 */

const BINANCE_BASE = 'https://fapi.binance.com';

// Map CoinGecko token IDs to Binance perp symbols
const TOKEN_TO_SYMBOL: Record<string, string> = {
  bitcoin: 'BTCUSDT',
  ethereum: 'ETHUSDT',
  solana: 'SOLUSDT',
  avalanche: 'AVAXUSDT',
  cardano: 'ADAUSDT',
  polkadot: 'DOTUSDT',
  near: 'NEARUSDT',
  cosmos: 'ATOMUSDT',
  sui: 'SUIUSDT',
  aptos: 'APTUSDT',
  uniswap: 'UNIUSDT',
  aave: 'AAVEUSDT',
  maker: 'MKRUSDT',
  chainlink: 'LINKUSDT',
  arbitrum: 'ARBUSDT',
  optimism: 'OPUSDT',
  polygon: 'MATICUSDT',
  dogecoin: 'DOGEUSDT',
  litecoin: 'LTCUSDT',
  filecoin: 'FILUSDT',
  render: 'RENDERUSDT',
  injective: 'INJUSDT',
  jupiter: 'JUPUSDT',
  pendle: 'PENDLEUSDT',
  pepe: 'PEPEUSDT',
};

export interface FundingRateData {
  rate8h: number;       // Current 8h funding rate (e.g., 0.0001 = 0.01%)
  annualizedRate: number; // Annualized funding rate
  exchange: string;
  symbol: string;
  timestamp: number;
}

export class FundingRateProvider {
  /** Get the current funding rate for a token. Returns null if token has no perp market. */
  async getFundingRate(tokenId: string): Promise<FundingRateData | null> {
    const symbol = TOKEN_TO_SYMBOL[tokenId];
    if (!symbol) return null;

    try {
      const res = await fetch(`${BINANCE_BASE}/fapi/v1/fundingRate?symbol=${symbol}&limit=1`);
      if (!res.ok) return null;

      const data = await res.json() as Array<{ fundingRate: string; fundingTime: number }>;
      if (!data || data.length === 0) return null;

      const rate8h = parseFloat(data[0]!.fundingRate);
      if (!Number.isFinite(rate8h)) return null;
      // Annualize: 3 funding periods per day × 365 days
      const annualizedRate = rate8h * 3 * 365;

      return {
        rate8h,
        annualizedRate,
        exchange: 'binance',
        symbol,
        timestamp: data[0]!.fundingTime,
      };
    } catch {
      return null;
    }
  }
}
