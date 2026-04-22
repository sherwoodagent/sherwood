/**
 * CryptoCompare social / news wrapper via Fincept bridge.
 */

import { callFincept } from './bridge.js';

const NEWS_CACHE_TTL = 10 * 60 * 1_000; // 10 minutes

/** Map CoinGecko token IDs → CryptoCompare symbols. */
const CC_SYMBOL_MAP: Record<string, string> = {
  bitcoin: 'BTC',
  ethereum: 'ETH',
  solana: 'SOL',
  aave: 'AAVE',
  uniswap: 'UNI',
  chainlink: 'LINK',
  ripple: 'XRP',
  dogecoin: 'DOGE',
  polkadot: 'DOT',
  avalanche: 'AVAX',
  arbitrum: 'ARB',
  hyperliquid: 'HYPE',
  zcash: 'ZEC',
  fartcoin: 'FARTCOIN',
  pepe: 'PEPE',
  cardano: 'ADA',
  ethena: 'ENA',
  'worldcoin-wld': 'WLD',
  bittensor: 'TAO',
  sui: 'SUI',
  near: 'NEAR',
  aptos: 'APT',
};

export interface SocialData {
  socialVolume24h: number;
  socialVolumeSpike: number;
  newsCount24h: number;
  topNewsSentiment: number;
}

/**
 * Fetch CryptoCompare news and derive social-data metrics for a token.
 * Returns null when news data is unavailable.
 */
export async function getSocialData(tokenId: string): Promise<SocialData | null> {
  const symbol = CC_SYMBOL_MAP[tokenId] ?? tokenId.toUpperCase();

  try {
    const newsResult = await callFincept(
      'cryptocompare_data.py',
      ['news'],
      30_000,
      NEWS_CACHE_TTL,
    );

    const rawData = newsResult.ok ? (newsResult.data as Record<string, unknown>) : undefined;
    const articles: Array<{ title?: string; categories?: string; tags?: string }> =
      (rawData?.Data as Array<{ title?: string; categories?: string; tags?: string }>) ?? [];

    const lowerSymbol = symbol.toLowerCase();
    const lowerTokenId = tokenId.toLowerCase();

    const matchingArticles = articles.filter((a) => {
      const haystack = [a.title, a.categories, a.tags]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(lowerSymbol) || haystack.includes(lowerTokenId);
    });

    return {
      socialVolume24h: matchingArticles.length,
      socialVolumeSpike: 1.0, // baseline — no historical comparison available
      newsCount24h: matchingArticles.length,
      topNewsSentiment: 0, // CryptoCompare doesn't have sentiment scores
    };
  } catch {
    return null;
  }
}
