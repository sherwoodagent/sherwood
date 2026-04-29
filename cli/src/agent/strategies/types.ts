/**
 * Strategy module types — base interfaces for all trading strategies.
 */

import type { Signal } from '../scoring.js';
import type { Candle, TechnicalSignals } from '../technical.js';

export type { Candle, TechnicalSignals };

export interface StrategyConfig {
  enabled: boolean;
  weight: number;  // override default weight
  params: Record<string, any>;
}

export interface StrategyContext {
  tokenId: string;
  candles?: Candle[];
  technicals?: TechnicalSignals;
  fearAndGreed?: { value: number; classification: string };
  sentimentZScore?: number;
  tvlData?: any;              // from DefiLlama
  marketData?: any;           // from CoinGecko
  nansenData?: any;           // from x402 research (Nansen)
  messariData?: any;          // from x402 research (Messari)
  dexData?: any;              // from DEXScreener
  fundingRateData?: {         // from Binance (free)
    rate8h: number;
    annualizedRate: number;
    exchange: string;
  };
  twitterData?: {             // from Twitter API v2 + OpenAI LLM
    mentionVolume: number;
    sentimentScore: number;
    engagementWeightedSentiment: number;
    volumeSpike: number;
    tweetCount: number;
    llmSentiment?: number;
    llmConfidence?: number;
    llmBullishPercent?: number;
    llmBearishPercent?: number;
  };
  unlockData?: {              // from DefiLlama FDV analysis (free)
    upcomingUnlocks: Array<{ percentOfSupply: number; daysUntil: number; description: string }>;
    totalUpcomingPercent: number;
  };
  hyperliquidData?: {         // from Hyperliquid (free, native exchange data)
    fundingRate: number;
    openInterest: number;
    oiChangePct: number;
    volume24h: number;
    markPrice: number;
    oraclePrice: number;
    prevDayPrice: number;
    orderBookImbalance: number;
    largeTradesBias: number;
  };
  /** Fincept: Blockchain.com BTC network stats. */
  btcNetworkData?: {
    hashRate: number;
    difficulty: number;
    mempoolSize: number;
    minerRevenueBtc: number;
    marketPriceUsd: number;
    transactionCount: number;
  };
  /** Fincept: Messari fundamentals (supply, revenue, developer activity). */
  messariFundamentals?: {
    marketCap: number;
    supply: { circulating: number; max: number; percentCirculating: number };
    revenueUsd24h: number;
    revenueGrowth7d: number;
    developerActivity: number;
  };
  /** Fincept: CryptoCompare social volume + news sentiment. */
  socialData?: {
    socialVolume24h: number;
    socialVolumeSpike: number;
    newsCount24h: number;
    topNewsSentiment: number;
  };
  tokenSymbol?: string;       // resolved symbol (e.g. "ETH" for "ethereum")
  groupReturns?: Record<string, number>;  // cross-sectional: 7-day returns for all tokens in cycle
  /** Fincept: Polymarket/Manifold prediction market probabilities. */
  predictionData?: {
    markets: Array<{
      question: string;
      probability: number;
      volume: number;
    }>;
  };
  /** Kronos ML volatility forecast — predicted vol and directional bias. */
  kronosData?: {
    predictedVolatility: number;
    predictedVol4h: number;
    directionalBias: number;
    pathSpreadPct: number;
    lastClose: number;
    meanPredictedClose: number;
    inferenceTimeMs: number;
  };
  /** Nansen smart-money netflow (aggregate across chains). */
  nansenFlowData?: {
    netFlow24hUsd: number;
    traderCount: number;
  };
  /** Nansen HL perp smart-money trades (same venue we trade on). */
  nansenHlPerps?: {
    longRatio: number;       // 0-1, fraction of smart money going long
    tradeCount: number;
    longValueUsd: number;
    shortValueUsd: number;
  };
}

export interface Strategy {
  name: string;
  description: string;
  requiredData: string[];  // what data this strategy needs
  analyze(ctx: StrategyContext): Promise<Signal>;
}
