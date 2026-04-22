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
  /** Fincept: Glassnode on-chain metrics (BTC/ETH). */
  glassnodeData?: {
    activeAddresses: number;
    activeAddressesGrowth: number;
    nvtRatio: number;
    sopr: number;
    transactionCount: number;
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
}

export interface Strategy {
  name: string;
  description: string;
  requiredData: string[];  // what data this strategy needs
  analyze(ctx: StrategyContext): Promise<Signal>;
}
