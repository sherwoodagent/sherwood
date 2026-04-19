/**
 * Main trading agent orchestrator.
 * Gathers data from multiple providers, scores signals, produces trade decisions.
 */

import chalk from "chalk";
import { DefiLlamaProvider } from "../providers/data/defillama.js";
import { CoinGeckoProvider } from "../providers/data/coingecko.js";
import { SentimentProvider } from "../providers/data/sentiment.js";
import { getResearchProvider } from "../providers/research/index.js";
import type { Candle, TechnicalSignals } from "./technical.js";
import { getLatestSignals } from "./technical.js";
import {
  scoreTechnical,
  scoreSentiment,
  scoreOnChain,
  scoreFundamental,
  scoreEvent,
  computeTradeDecision,
  DEFAULT_WEIGHTS,
  profileForToken,
} from "./scoring.js";
import type { Signal, ScoringWeights, TradeDecision } from "./scoring.js";
import { runStrategies } from "./strategies/index.js";
import { DexScreenerProvider } from "../providers/data/dexscreener.js";
import { FundingRateProvider } from "../providers/data/funding-rate.js";
import { TokenUnlocksProvider } from "../providers/data/token-unlocks.js";
import { TwitterSentimentProvider } from "../providers/data/twitter.js";
import { logSignal } from "./signal-logger.js";
import type { JudgeLogData, CalibrationLogData } from "./signal-logger.js";
import { LiveCalibrator } from './calibration-live.js';
import { computeCalibratedTradeDecision } from './scoring.js';
import { judge, selectJudgeCandidates, DEFAULT_JUDGE_CONFIG } from "./judge.js";
import type { JudgeConfig, JudgeVerdict, JudgeContext } from "./judge.js";
import { SignalSmoother, FileSmootherStorage, DEFAULT_SMOOTHER_CONFIG } from "./signal-smoother.js";
import { applyVelocityGate, resolveVelocity, DEFAULT_ENTRY_GATE_CONFIG } from "./entry-gates.js";
import type { EntryGateConfig } from "./entry-gates.js";
import { join as joinPath } from "node:path";
import { homedir as getHomedir } from "node:os";
import { HyperliquidProvider } from "../providers/data/hyperliquid.js";
import type { StrategyContext, StrategyConfig } from "./strategies/index.js";
import { MarketRegimeDetector } from "./regime.js";
import type { RegimeAnalysis } from "./regime.js";
import { CorrelationGuard } from "./correlation.js";
import type { CorrelationCheck } from "./correlation.js";
import { AlertSystem } from "./alerts.js";
import type { Alert } from "./alerts.js";
import type { PortfolioState } from "./risk.js";
import { isX402WalletFunded } from "../lib/x402.js";

export type { Signal, ScoringWeights, TradeDecision, Alert, TechnicalSignals };

export interface AgentConfig {
  tokens: string[];
  cycle: "15m" | "1h" | "4h";
  dryRun: boolean;
  maxPositionPct: number;
  maxRiskPct: number;
  weights?: ScoringWeights;
  /** Named weight profile (default | majors | altcoin | sentHeavy | techHeavy).
   *  When set, overrides `weights` and is applied per-token via profileForToken().
   *  When unset, BTC/ETH/SOL auto-get the "majors" profile, others use default. */
  weightProfile?: string;
  /** When true, includes paid x402 data (Nansen smart-money, Messari fundamentals) in analysis. */
  useX402?: boolean;
  /** Only run x402 paid signals on the top N tokens by free-signal score.
   *  Remaining tokens use free signals only. Reduces x402 cost from ~$1.60/run
   *  (10 tokens × $0.16) to ~$0.48/run (3 tokens × $0.16).
   *  Set to 0 or undefined to run x402 on all tokens (old behavior). */
  x402TopN?: number;
  /** When true, smooth fast/noisy signals (HL flow, smartMoney, dexFlow, fundingRate)
   *  with a rolling 3-reading average before scoring. Reduces single-scan flicker.
   *  Default false. */
  smoothFastSignals?: boolean;
  /** Per-strategy configuration overrides. */
  strategyConfigs?: Record<string, StrategyConfig>;
  /** LLM judge configuration — confirms or vetoes borderline trade decisions. */
  judge?: Partial<JudgeConfig>;
  /** Entry-gate configuration — velocity/freshness checks applied post-scoring. */
  entryGates?: Partial<EntryGateConfig>;
  /** Backwards-compat opt-out: skip the velocity gate entirely. Equivalent to
   *  `entryGates: { velocityGateEnabled: false }`. Default false (gate active). */
  disableVelocityGate?: boolean;
}

export interface TokenAnalysis {
  token: string;
  decision: TradeDecision;
  data: {
    technicalSignals?: TechnicalSignals;
    fearAndGreed?: number;
    tvl?: number;
    price?: number;
  };
  regime?: RegimeAnalysis;
  correlation?: CorrelationCheck;
  /** LLM judge verdict (present only when judge is enabled and token was judged). */
  judgeResult?: { verdict: JudgeVerdict; cached: boolean; latencyMs: number };
  /** Original action/score before judge veto (present only when judge vetoed). */
  preJudge?: { action: string; score: number };
  /** Original action/score before velocity gate downgraded to HOLD. */
  preVelocity?: { action: string; score: number };
}

export class TradingAgent {
  private config: AgentConfig;
  private defillama: DefiLlamaProvider;
  private coingecko: CoinGeckoProvider;
  private sentiment: SentimentProvider;
  private dexscreener: DexScreenerProvider;
  private fundingRate: FundingRateProvider;
  private tokenUnlocks: TokenUnlocksProvider;
  private twitter: TwitterSentimentProvider;
  private hyperliquid: HyperliquidProvider;
  private regimeDetector: MarketRegimeDetector;
  private correlationGuard: CorrelationGuard;
  private alertSystem: AlertSystem;
  private smoother: SignalSmoother | null = null;
  private liveCalibrator: LiveCalibrator;
  /** Optional getter for current portfolio state. When set, judge receives
   *  real portfolio context (openCount, cashPct, etc.); otherwise judge falls
   *  back to neutral defaults and its portfolio-veto branch is effectively
   *  disabled. Wired in by AgentLoop via setPortfolioStateGetter(). */
  private portfolioStateGetter: (() => PortfolioState | undefined) | undefined;
  /** Warn-once flag when portfolio getter is missing at judge time. */
  private warnedNoPortfolioGetter = false;

  constructor(config: AgentConfig) {
    this.config = config;
    this.defillama = new DefiLlamaProvider();
    this.coingecko = new CoinGeckoProvider();
    this.sentiment = new SentimentProvider();
    this.dexscreener = new DexScreenerProvider();
    this.fundingRate = new FundingRateProvider();
    this.tokenUnlocks = new TokenUnlocksProvider();
    this.twitter = new TwitterSentimentProvider();
    this.hyperliquid = new HyperliquidProvider();
    this.regimeDetector = new MarketRegimeDetector();
    this.correlationGuard = new CorrelationGuard();
    this.alertSystem = new AlertSystem();
    this.liveCalibrator = new LiveCalibrator();
  }

  /** Analyze a single token — gather all data and score. */
  async analyzeToken(tokenId: string, opts?: { skipX402?: boolean }): Promise<TokenAnalysis> {
    const signals: Signal[] = [];
    let technicalSignals: TechnicalSignals | undefined;
    let fearAndGreedValue: number | undefined;
    let tvl: number | undefined;
    let candles: Candle[] | undefined;
    let sentimentZScore: number | undefined;

    // Phase 1: Parallel basic data fetching (OHLC, Fear & Greed, TVL, Hyperliquid)
    const [ohlcResult, fearGreedResult, tvlResult, hyperliquidResult] = await Promise.allSettled([
      // 1. Fetch OHLC data from CoinGecko
      this.coingecko.getOHLC(tokenId, 30).then(async (ohlcRaw) => {
        if (!ohlcRaw || ohlcRaw.length <= 10) return null;

        const rawCandles = ohlcRaw.map((c: number[]) => ({
          timestamp: c[0]!,
          open: c[1]!,
          high: c[2]!,
          low: c[3]!,
          close: c[4] ?? c[3]!, // CoinGecko OHLC: [ts, o, h, l, c]
          volume: 0, // OHLC endpoint doesn't include volume
        }));

        // Fetch volume data in parallel
        try {
          const marketData = await this.coingecko.getMarketData(tokenId, 30);
          if (marketData?.total_volumes) {
            // Map volumes to nearest candle by timestamp
            for (const candle of rawCandles) {
              const nearest = marketData.total_volumes.reduce(
                (best: number[], v: number[]) =>
                  Math.abs(v[0]! - candle.timestamp) < Math.abs(best[0]! - candle.timestamp)
                    ? v
                    : best,
                marketData.total_volumes[0]!,
              );
              candle.volume = nearest[1] ?? 0;
            }
          }
        } catch {
          // Volume data optional
        }

        return rawCandles;
      }),

      // 2. Fetch Fear & Greed
      this.sentiment.getFearAndGreed(),

      // 3. Fetch TVL data (if DeFi protocol)
      this.defillama.getProtocolTvl(tokenId).then(async (tvlValue) => {
        if (typeof tvlValue === "number" && tvlValue > 0) {
          const priceData = await this.coingecko.getPrice([tokenId], ["usd"]);
          const mcap = priceData?.[tokenId]?.usd_market_cap;
          return { tvl: tvlValue, mcapToTvl: mcap && tvlValue > 0 ? mcap / tvlValue : undefined };
        }
        return null;
      }),

      // 4. Fetch Hyperliquid data (free, exchange-native) — move to Phase 1 for price substitution
      this.hyperliquid.getHyperliquidData(tokenId)
    ]);

    // Process OHLC results
    if (ohlcResult.status === 'fulfilled' && ohlcResult.value) {
      candles = ohlcResult.value;
      technicalSignals = getLatestSignals(candles);
      signals.push(scoreTechnical(technicalSignals));

      // Price momentum signal — captures "the market is moving" before
      // lagging indicators (RSI, MACD, EMA) catch up. Uses the same candle
      // data we already have. Scored as a technical-category signal so it
      // adds to (not replaces) the existing technical analysis.
      if (candles.length >= 24) {
        const recent = candles.slice(-24);
        const currentClose = recent[recent.length - 1]!.close;
        const recentLow = Math.min(...recent.map((c) => c.low));
        const recentHigh = Math.max(...recent.map((c) => c.high));
        const pctFromLow = recentLow > 0 ? (currentClose - recentLow) / recentLow : 0;
        const pctFromHigh = recentHigh > 0 ? (recentHigh - currentClose) / recentHigh : 0;

        let momentumValue = 0;
        let momentumDetails = '';
        // Bullish momentum: price near 24-candle highs
        if (pctFromHigh < 0.01) {
          momentumValue = Math.min(0.6, pctFromLow * 5); // scales: 3% move → 0.15, 5% → 0.25, 10% → 0.50
          momentumDetails = `Price +${(pctFromLow * 100).toFixed(1)}% from 24-candle low, near highs`;
        }
        // Bearish momentum: price near 24-candle lows
        else if (pctFromLow < 0.01) {
          momentumValue = -Math.min(0.6, pctFromHigh * 5);
          momentumDetails = `Price -${(pctFromHigh * 100).toFixed(1)}% from 24-candle high, near lows`;
        }
        // Mid-range: proportional to position within range
        else if (recentHigh > recentLow) {
          const rangePosition = (currentClose - recentLow) / (recentHigh - recentLow); // 0=low, 1=high
          momentumValue = (rangePosition - 0.5) * 0.4; // -0.2 to +0.2
          momentumDetails = `Mid-range (${(rangePosition * 100).toFixed(0)}th percentile of 24-candle range)`;
        }

        if (Math.abs(momentumValue) > 0.02) {
          signals.push({
            name: 'momentum',
            value: momentumValue,
            confidence: Math.min(0.7, 0.3 + Math.abs(momentumValue)),
            source: 'Price Momentum',
            details: momentumDetails,
          });
        }
      }
    } else if (ohlcResult.status === 'rejected') {
      console.error(chalk.dim(`  Technical analysis failed for ${tokenId}: ${ohlcResult.reason}`));
    }

    // Process Fear & Greed results
    if (fearGreedResult.status === 'fulfilled' && fearGreedResult.value?.length > 0) {
      const fgData = fearGreedResult.value;
      fearAndGreedValue = fgData[0]!.value;
      const values = fgData.map((d) => d.value);
      sentimentZScore = this.sentiment.computeSentimentZScore(values);
      // F&G is used as a regime-gate (extreme fear = allow BUY, extreme greed = allow SELL)
      // NOT as a scoring signal. It fires at +0.76 on 100% of observations when F&G < 25,
      // making it a constant bias rather than a directional signal. The sentimentContrarian
      // strategy (which modulates based on actual F&G value) remains active.
      // signals.push(scoreSentiment(fearAndGreedValue, sentimentZScore)); // REMOVED: constant bias
    } else if (fearGreedResult.status === 'rejected') {
      console.error(chalk.dim(`  Sentiment data failed: ${fearGreedResult.reason}`));
    }

    // Process Hyperliquid results first to use for price substitution
    let hyperliquidData: any = undefined;
    if (hyperliquidResult.status === 'fulfilled' && hyperliquidResult.value) {
      hyperliquidData = hyperliquidResult.value;
    }

    // Process TVL results — use Hyperliquid price if available instead of calling CoinGecko
    if (tvlResult.status === 'fulfilled' && tvlResult.value) {
      const { tvl: tvlValue } = tvlResult.value;
      tvl = tvlValue;

      // Calculate mcapToTvl ratio using Hyperliquid price if available
      let mcapToTvl: number | undefined;
      if (hyperliquidData?.markPrice) {
        // Use Hyperliquid mark price instead of CoinGecko
        try {
          const coinDetails = await this.coingecko.getCoinDetails(tokenId);
          const circSupply = coinDetails?.market_data?.circulating_supply;
          if (circSupply) {
            const mcap = hyperliquidData.markPrice * circSupply;
            mcapToTvl = tvlValue > 0 ? mcap / tvlValue : undefined;
          }
        } catch {
          // Fall back to original CoinGecko approach if coin details fail
          const priceData = await this.coingecko.getPrice([tokenId], ["usd"]);
          const mcap = priceData?.[tokenId]?.usd_market_cap;
          mcapToTvl = mcap && tvlValue > 0 ? mcap / tvlValue : undefined;
        }
      } else {
        // Fall back to CoinGecko price
        const priceData = await this.coingecko.getPrice([tokenId], ["usd"]);
        const mcap = priceData?.[tokenId]?.usd_market_cap;
        mcapToTvl = mcap && tvlValue > 0 ? mcap / tvlValue : undefined;
      }

      signals.push(scoreFundamental({ mcapToTvl }));
    } else {
      // Not all tokens have TVL data, that's fine
      signals.push(scoreFundamental({}));
    }

    // Shared research data — captured in phase 2, reused in phase 3 strategies
    let nansenData: any = undefined;
    let messariData: any = undefined;

    // Check x402 wallet USDC balance once per scan cycle.
    // If wallet is unfunded, skip x402 calls entirely to avoid diluting scores.
    // undefined = x402 not configured (don't exclude categories)
    // true = x402 configured + wallet funded
    // false = x402 configured but wallet empty → exclude dead categories
    const x402Enabled = this.config.useX402 && !opts?.skipX402;
    let x402Available: boolean | undefined = x402Enabled ? false : undefined;
    if (x402Enabled) {
      x402Available = await isX402WalletFunded();
      if (!x402Available) {
        console.error(chalk.yellow(`  x402 wallet has insufficient USDC — skipping paid signals (smartMoney, event) for this cycle`));
      }
    }

    // Phase 2: Nansen x402 research data (Messari dropped — low value for majors)
    //
    // Two Nansen calls in parallel:
    //   1. Smart-money netflows (multi-chain: ethereum, solana, base, L2s)
    //      — was previously Base-only, returning empty for BTC/ETH/SOL
    //   2. Hyperliquid smart-money perp trades — same venue we trade on,
    //      shows what Funds/Smart Traders are doing right now
    if (x402Enabled && x402Available) {
      // Map tokenId to HL symbol for perp-trades query
      const hlSymbolMap: Record<string, string> = {
        bitcoin: "BTC", ethereum: "ETH", solana: "SOL",
        arbitrum: "ARB", aave: "AAVE", uniswap: "UNI",
        dogecoin: "DOGE", ripple: "XRP", hyperliquid: "HYPE",
        "worldcoin-wld": "WLD", bittensor: "TAO", zcash: "ZEC",
        fartcoin: "FARTCOIN", pepe: "PEPE", polkadot: "DOT",
      };
      const hlSymbol = hlSymbolMap[tokenId] ?? tokenId.toUpperCase();

      const nansenProvider = getResearchProvider("nansen") as import("../providers/research/nansen.js").NansenProvider;

      // Nansen netflow dropped — returns 422 for token_symbol filter.
      // HL perp-trades is the higher-value signal (same venue we trade).
      const [hlPerpResult, flowResult] = await Promise.allSettled([
        nansenProvider.queryHyperliquidSmartMoney(hlSymbol),
        nansenProvider.queryFlowIntelligence(hlSymbol),
      ]);

      // Process HL perp trades — derive a smartMoney signal from recent trade direction
      if (hlPerpResult.status === 'fulfilled') {
        const hlResult = hlPerpResult.value;
        const trades = hlResult.data.trades as Array<Record<string, unknown>> | undefined;
        if (trades && trades.length > 0) {
          // Count longs vs shorts among smart money's recent trades
          let longValueUsd = 0;
          let shortValueUsd = 0;
          for (const t of trades) {
            const val = Number(t.value_usd ?? 0);
            const side = String(t.side ?? '').toLowerCase();
            if (side === 'long') longValueUsd += val;
            else if (side === 'short') shortValueUsd += val;
          }
          const totalValue = longValueUsd + shortValueUsd;
          const longRatio = totalValue > 0 ? longValueUsd / totalValue : 0.5;
          // longRatio 0.7+ = smart money heavily long = bullish
          // longRatio 0.3- = smart money heavily short = bearish
          const smBias = (longRatio - 0.5) * 2; // -1 to +1

          // Push as a smartMoney signal. Scale to ±0.5 max (not ±0.8) —
          // a single Nansen snapshot shouldn't dominate the entire score.
          // At smartMoney weight 0.15 (majors profile), ±0.5 contributes
          // ±0.075 to aggregate — meaningful but well below sentiment/onchain.
          signals.push({
            name: 'smartMoney',
            value: smBias * 0.5,
            confidence: Math.min(0.7, 0.3 + (trades.length / 30) * 0.4),
            source: 'Nansen HL Smart Money',
            details: `${trades.length} trades: $${(longValueUsd / 1e6).toFixed(1)}M long / $${(shortValueUsd / 1e6).toFixed(1)}M short (${(longRatio * 100).toFixed(0)}% long)`,
          });
          console.error(chalk.dim(`  x402 Nansen HL perps: ${trades.length} trades, ${(longRatio * 100).toFixed(0)}% long bias, cost ${hlResult.costUsdc} USDC`));
        } else {
          console.error(chalk.dim(`  x402 Nansen HL perps: no recent trades for ${hlSymbol}`));
        }
      } else {
        console.error(chalk.dim(`  x402 Nansen HL perps unavailable: ${hlPerpResult.reason}`));
      }

      // Flow Intelligence — aggregate accumulation/distribution by investor type
      if (flowResult.status === 'fulfilled' && flowResult.value?.data) {
        const flowData = flowResult.value.data as Record<string, unknown>;
        // The API returns flow data by investor type. Extract net flows.
        // Positive net_flow = smart money accumulating = bullish.
        // Negative net_flow = smart money distributing = bearish.
        const netFlow = Number(flowData.net_flow_24h_usd ?? flowData.net_flow ?? 0);
        if (netFlow !== 0 && !isNaN(netFlow)) {
          // Normalize: $1M+ flow = strong signal (±0.5), scale linearly
          const normalizedFlow = Math.max(-0.5, Math.min(0.5, netFlow / 2_000_000));
          signals.push({
            name: 'flowIntelligence',
            value: normalizedFlow,
            confidence: Math.min(0.7, 0.3 + Math.abs(normalizedFlow)),
            source: 'Nansen Flow Intelligence',
            details: `Smart money 24h net flow: $${(netFlow / 1_000_000).toFixed(2)}M ${netFlow > 0 ? '(accumulating)' : '(distributing)'}`,
          });
          console.error(chalk.dim(`  Nansen flow-intelligence: $${(netFlow / 1_000_000).toFixed(2)}M net flow, cost ${flowResult.value.costUsdc}`));
        }
      }

      // Push event signal (no Messari — use free path)
      signals.push(scoreEvent({}));
    }
    // Free path: don't push empty fundamental/event signals that always return
    // value=0. They participate in per-category weight normalization and dilute
    // signals that actually fire. Only push when there's real data (TVL from
    // phase 1, or Nansen/Messari from x402).

    // Phase 3: Parallel strategy data fetching (symbol, funding rate, unlocks)
    let marketData: any = undefined;

    try {
      // Twitter sentiment fetch removed — API returns 402 (paid tier required)
      // for most token queries and was spamming logs without producing usable
      // signal. TwitterSentimentStrategy is also disabled in DEFAULT_STRATEGIES.
      const [symbolResult, fundingRateResult, unlockResult] = await Promise.allSettled([
        // Resolve token symbol + get market data for strategies
        this.coingecko.getCoinDetails(tokenId).then(async (coinDetails) => {
          const symbol = coinDetails?.symbol?.toUpperCase();
          const marketData = await this.coingecko.getMarketData(tokenId, 7);
          return { symbol, marketData };
        }),

        // Fetch funding rate data (free, from Binance)
        this.fundingRate.getFundingRate(tokenId),

        // Fetch token unlock estimates (free, from DefiLlama FDV)
        this.tokenUnlocks.getUnlocks(tokenId),
      ]);

      // Process symbol/market data results
      let tokenSymbol: string | undefined;
      if (symbolResult.status === 'fulfilled' && symbolResult.value) {
        tokenSymbol = symbolResult.value.symbol;
        marketData = symbolResult.value.marketData;
      }

      // Process funding rate — prefer Hyperliquid (native, same venue we trade on).
      // Fall back to Binance only if HL doesn't cover this token.
      // HL publishes hourly funding; convert to 8h-equivalent so strategy
      // thresholds remain unit-consistent with Binance.
      let fundingRateData: StrategyContext['fundingRateData'] = undefined;
      if (hyperliquidData && typeof hyperliquidData.fundingRate === 'number' && Number.isFinite(hyperliquidData.fundingRate)) {
        const rate1h = hyperliquidData.fundingRate;
        const rate8h = rate1h * 8;
        const annualizedRate = rate1h * 24 * 365;
        fundingRateData = { rate8h, annualizedRate, exchange: 'hyperliquid' };
      } else if (fundingRateResult.status === 'fulfilled' && fundingRateResult.value) {
        const fr = fundingRateResult.value;
        fundingRateData = { rate8h: fr.rate8h, annualizedRate: fr.annualizedRate, exchange: fr.exchange };
      }

      // Process unlock results
      let unlockData: StrategyContext['unlockData'] = undefined;
      if (unlockResult.status === 'fulfilled' && unlockResult.value) {
        unlockData = unlockResult.value;
      }

      // Twitter data omitted — strategy disabled (see DEFAULT_STRATEGIES).
      const twitterData: StrategyContext['twitterData'] = undefined;

      // Hyperliquid data already processed in Phase 1

      const stratCtx: StrategyContext = {
        tokenId,
        candles, // reuse from phase 1
        technicals: technicalSignals,
        fearAndGreed: fearAndGreedValue !== undefined
          ? { value: fearAndGreedValue, classification: fearAndGreedValue < 25 ? 'fear' : fearAndGreedValue > 75 ? 'greed' : 'neutral' }
          : undefined,
        sentimentZScore, // reuse from phase 1
        tvlData: tvl,
        marketData,
        nansenData, // from phase 2
        messariData, // from phase 2
        dexData: undefined, // DexFlowStrategy fetches this internally
        fundingRateData, // from phase 3
        unlockData, // from phase 3
        twitterData, // from phase 3
        hyperliquidData, // from phase 3
        tokenSymbol, // from phase 3
      };

      let strategySignals = await runStrategies(stratCtx, this.config.strategyConfigs);

      // Smooth fast/noisy signals (HL flow, smartMoney, dexFlow, fundingRate)
      // with a rolling 3-reading average. Slow signals pass through unchanged.
      // Disabled by default — enable via --smooth flag or config.smoothFastSignals.
      if (this.config.smoothFastSignals) {
        if (!this.smoother) {
          this.smoother = new SignalSmoother(
            new FileSmootherStorage(joinPath(getHomedir(), '.sherwood', 'agent', 'signal-cache.json')),
            DEFAULT_SMOOTHER_CONFIG,
          );
        }
        try {
          strategySignals = await this.smoother.smooth(tokenId, strategySignals);
        } catch (err) {
          console.error(chalk.dim(`  Signal smoothing failed (using raw): ${(err as Error).message}`));
        }
      }

      // Merge strategy signals: only add those with meaningful confidence (>0.05)
      for (const sig of strategySignals) {
        if (sig.confidence > 0.05) {
          signals.push(sig);
        }
      }
    } catch (err) {
      console.error(chalk.dim(`  Strategy modules failed: ${(err as Error).message}`));
    }

    // 6. Market regime detection
    let regimeAnalysis: RegimeAnalysis | undefined;
    try {
      let btcCandles: Candle[] = candles || [];

      // If analyzing a non-BTC token, fetch BTC candles for regime analysis
      if (tokenId !== "bitcoin" && (!candles || candles.length < 100)) {
        const btcOhlc = await this.coingecko.getOHLC("bitcoin", 200);
        if (btcOhlc && btcOhlc.length > 100) {
          btcCandles = btcOhlc.map((c: number[]) => ({
            timestamp: c[0]!,
            open: c[1]!,
            high: c[2]!,
            low: c[3]!,
            close: c[4] ?? c[3]!,
            volume: 0, // Volume not needed for regime detection
          }));
        }
      }

      if (btcCandles.length > 100) {
        regimeAnalysis = await this.regimeDetector.detect(btcCandles);
      }
    } catch (err) {
      console.error(chalk.dim(`  Regime detection failed: ${(err as Error).message}`));
    }

    // 7. BTC correlation check
    let correlationCheck: CorrelationCheck | undefined;
    try {
      correlationCheck = await this.correlationGuard.checkCorrelation(tokenId);
    } catch (err) {
      console.error(chalk.dim(`  Correlation check failed: ${(err as Error).message}`));
    }

    // 8. Compute decision with regime adjustments, correlation suppression,
    //    and regime-conditional action thresholds. Weights resolution order:
    //    explicit this.config.weights > weightProfile > per-token auto-profile.
    const resolvedWeights = this.config.weights
      ?? profileForToken(tokenId, this.config.weightProfile);
    const decision = computeTradeDecision(
      signals,
      resolvedWeights,
      regimeAnalysis?.strategyAdjustments,
      correlationCheck,
      regimeAnalysis?.regime,
      x402Available,
    );

    const currentPrice = hyperliquidData?.markPrice
      ?? (candles && candles.length > 0 ? candles[candles.length - 1]!.close : 0);

    const result: TokenAnalysis = {
      token: tokenId,
      decision,
      data: { technicalSignals, fearAndGreed: fearAndGreedValue, tvl, price: currentPrice },
      regime: regimeAnalysis,
      correlation: correlationCheck,
    };

    // ── Velocity freshness gate (Orca-inspired) ──
    // Refuse BUY/SELL if the most recent short-term price move is flat or
    // opposed to the signal direction — prevents "buying local tops" and
    // "shorting local bottoms" when the composite score fires late.
    const gateConfig: EntryGateConfig = {
      ...DEFAULT_ENTRY_GATE_CONFIG,
      ...this.config.entryGates,
      // Legacy opt-out flag wins if set explicitly.
      ...(this.config.disableVelocityGate ? { velocityGateEnabled: false } : {}),
    };
    // Hyperliquid does not currently expose a `priceChg1h` field; resolveVelocity
    // is written to accept one in case the provider adds it later. For now we
    // always fall through to the candle-based derivation (4h cadence with
    // days=30 OHLC — tightest proxy available).
    const priceChg1h = (hyperliquidData as { priceChg1h?: number } | undefined)?.priceChg1h;
    const velocity = resolveVelocity(priceChg1h, candles);
    const gatedResult = applyVelocityGate(result, velocity, gateConfig, (msg) =>
      console.error(chalk.yellow(msg)),
    );

    // Note: logSignal() is intentionally NOT called here. It runs in
    // analyzeAll() AFTER the judge pass, so judge verdicts can be included
    // in signal-history.jsonl. See analyzeAll() below.

    return gatedResult;
  }

  /** Update the token watchlist without recreating the agent (preserves caches). */
  updateTokens(tokens: string[]): void {
    this.config.tokens = tokens;
  }

  /** Register a getter for current portfolio state. Called by AgentLoop so
   *  the judge can see real openCount / cashPct / daily PnL / cooldowns when
   *  building its veto decisions. If not set, judge uses neutral defaults. */
  setPortfolioStateGetter(fn: () => PortfolioState | undefined): void {
    this.portfolioStateGetter = fn;
  }

  /** Analyze all watchlist tokens.
   *
   *  When `x402TopN` is set and x402 is enabled, uses a two-pass approach:
   *  1. Score ALL tokens with free signals only (no x402 cost)
   *  2. Re-score the top N tokens by free-signal score WITH x402 paid data
   *
   *  This reduces x402 cost from ~$0.16×10 = $1.60/run to ~$0.16×3 = $0.48/run
   *  while concentrating paid data on the tokens most likely to fire trades.
   */
  async analyzeAll(): Promise<TokenAnalysis[]> {
    const topN = this.config.x402TopN;
    const shouldTwoPass = this.config.useX402 && topN && topN > 0 && topN < this.config.tokens.length;

    let results: TokenAnalysis[];

    if (!shouldTwoPass) {
      // Original single-pass: analyze all tokens with whatever x402 config says
      results = [];
      for (const token of this.config.tokens) {
        const result = await this.analyzeToken(token);
        results.push(result);
      }
    } else {
      // Pass 1: all tokens with free signals only
      console.error(chalk.dim(`  x402 top-${topN} mode: scoring all ${this.config.tokens.length} tokens with free signals first...`));
      const freeResults: TokenAnalysis[] = [];
      for (const token of this.config.tokens) {
        const result = await this.analyzeToken(token, { skipX402: true });
        freeResults.push(result);
      }

      // Sort by absolute score descending — top N get the x402 enrichment
      const ranked = [...freeResults].sort(
        (a, b) => Math.abs(b.decision.score) - Math.abs(a.decision.score),
      );
      const topTokens = new Set(ranked.slice(0, topN).map((r) => r.token));
      console.error(chalk.dim(`  x402 enriching top ${topN}: ${[...topTokens].join(', ')}`));

      // Pass 2: re-analyze top N with x402 enabled
      const enrichedMap = new Map<string, TokenAnalysis>();
      for (const token of topTokens) {
        const enriched = await this.analyzeToken(token);
        enrichedMap.set(token, enriched);
      }

      // Merge: use enriched results for top N, free results for the rest
      results = freeResults.map((r) => enrichedMap.get(r.token) ?? r);
    }

    // ── LLM Judge pass ──
    // After all tokens scored, apply the judge to borderline actionable decisions.
    // Budget-gated: only the top-N borderline candidates are judged per cycle.
    const judgeConfig: JudgeConfig = { ...DEFAULT_JUDGE_CONFIG, ...this.config.judge };
    if (judgeConfig.enabled) {
      const candidates = selectJudgeCandidates(
        results.map((r) => ({ token: r.token, score: r.decision.score, action: r.decision.action })),
        judgeConfig,
      );

      if (candidates.size > 0) {
        console.error(chalk.dim(`  [judge] Reviewing ${candidates.size} borderline decision(s): ${[...candidates].join(', ')}`));
      }

      // Snapshot portfolio state once for the judge pass — all tokens in this
      // cycle see the same portfolio view. Cheaper than a per-token load and
      // avoids races with any concurrent mutation.
      const pstate = this.portfolioStateGetter?.();
      if (!pstate && candidates.size > 0 && !this.warnedNoPortfolioGetter) {
        console.warn(chalk.yellow(
          `  [judge] Warning: portfolio state getter not wired. Judge portfolio-veto branch disabled — using neutral defaults.`,
        ));
        this.warnedNoPortfolioGetter = true;
      }

      for (const result of results) {
        if (!candidates.has(result.token)) continue;

        // Build real portfolio snapshot for the judge. Falls back to neutral
        // defaults when the getter isn't wired (e.g. one-shot analyzeAll callers).
        let portfolio: JudgeContext["portfolio"] = {
          openCount: 0, cashPct: 1, hasPositionThisToken: false, inStopCooldown: false, dailyPnlPct: 0,
        };
        if (pstate) {
          const totalValue = pstate.totalValue || pstate.cash || 0;
          const cooldowns = pstate.stopCooldowns ?? {};
          const cooldownAt = cooldowns[result.token];
          // Match RiskManager's STOP_COOLDOWN_MS (4h). We only need to know
          // whether a cooldown is currently active, not the exact deadline.
          const STOP_COOLDOWN_MS = 4 * 60 * 60 * 1000;
          const inStopCooldown = cooldownAt !== undefined &&
            (Date.now() - cooldownAt) < STOP_COOLDOWN_MS;
          // dailyPnlPct ≈ dailyPnl / (totalValue − dailyPnl), reconstructing
          // the start-of-day value from current total minus today's delta.
          const startOfDayValue = totalValue - pstate.dailyPnl;
          portfolio = {
            openCount: pstate.positions.length,
            cashPct: totalValue > 0 ? pstate.cash / totalValue : 1,
            hasPositionThisToken: !!pstate.positions.find((p) => p.tokenId === result.token),
            inStopCooldown,
            dailyPnlPct: startOfDayValue > 0 ? pstate.dailyPnl / startOfDayValue : 0,
          };
        }

        const ctx: JudgeContext = {
          tokenId: result.token,
          currentPrice: result.data.price ?? 0,
          decision: result.decision,
          technicalSignals: result.data.technicalSignals,
          fearAndGreed: result.data.fearAndGreed,
          regime: result.regime?.regime,
          btcBias: result.correlation?.btcBias,
          suppressionFactor: result.correlation?.suppressionFactor,
          portfolio,
        };

        const judgeResult = await judge(ctx, judgeConfig);
        result.judgeResult = judgeResult;

        if (judgeResult.verdict.verdict === "veto") {
          result.preJudge = { action: result.decision.action, score: result.decision.score };
          result.decision = { ...result.decision, action: "HOLD" };
          console.error(chalk.yellow(`  [judge] VETO ${result.token}: ${judgeResult.verdict.reasoning}`));
        } else if (judgeResult.verdict.verdict === "confirm" && judgeResult.verdict.reasoning !== "fallback") {
          console.error(chalk.dim(`  [judge] Confirmed ${result.token} (${judgeResult.cached ? "cached" : `${judgeResult.latencyMs}ms`})`));
        }
      }
    }

    // Persist analysis to ~/.sherwood/agent/signal-history.jsonl. Runs AFTER
    // the judge pass so judgeVerdict fields land in signal-history.jsonl.
    // Fire-and-forget — never blocks scoring, never crashes on disk failure.
    for (const result of results) {
      const resolvedWeights = this.config.weights
        ?? profileForToken(result.token, this.config.weightProfile);
      const price = result.data.price ?? 0;
      const judgeData: JudgeLogData | undefined = result.judgeResult
        ? {
            verdict: result.judgeResult.verdict,
            // Prefer pre-veto action/score when judge vetoed; otherwise log
            // current (post-judge) action/score — they're identical on confirm.
            preJudgeAction: result.preJudge?.action ?? result.decision.action,
            preJudgeScore: result.preJudge?.score ?? result.decision.score,
            latencyMs: result.judgeResult.latencyMs,
            cached: result.judgeResult.cached,
          }
        : undefined;

      // Calculate calibration and uncertainty metrics
      let calibrationData: CalibrationLogData | undefined;
      try {
        // Get action family for calibration
        const actionFamily = result.decision.action.includes('BUY') ? 'BUY' :
                            result.decision.action.includes('SELL') ? 'SELL' : 'HOLD';

        // Get calibration factor
        const calibrationFactor = this.liveCalibrator.getCalibrationFactor(
          result.token,
          result.regime?.regime ?? 'unknown',
          actionFamily
        );

        // Calculate uncertainty metrics (using available signals, simple price array)
        const recentPrices = price > 0 ? [price] : []; // Simplified - use current price only
        const uncertaintyMetrics = this.liveCalibrator.calculateUncertainty(
          result.decision.signals,
          recentPrices,
          result.token
        );

        calibrationData = {
          calibrationFactor,
          uncertaintyMetrics
        };
      } catch (error) {
        console.warn(`[calibration] Warning: failed to calculate calibration for ${result.token}: ${(error as Error).message}`);
      }

      logSignal(result, price, resolvedWeights, judgeData, calibrationData);
    }

    return results;
  }

  /** Analyze all tokens and generate alerts for state changes. */
  async analyzeAllWithAlerts(): Promise<{ analyses: TokenAnalysis[]; alerts: Alert[] }> {
    const analyses = await this.analyzeAll();
    const alerts = await this.alertSystem.processAnalysis(analyses);
    return { analyses, alerts };
  }

  /** Get recent alerts. */
  async getRecentAlerts(maxAge?: number): Promise<Alert[]> {
    return this.alertSystem.getRecentAlerts(maxAge);
  }

  /** Clear all alerts. */
  async clearAlerts(): Promise<void> {
    return this.alertSystem.clearAlerts();
  }

  /** Get urgent alerts (CRITICAL/HIGH from last 30min) and mark as sent. */
  async getUrgentAlerts(): Promise<Alert[]> {
    return this.alertSystem.getUrgentAlerts();
  }

  /** Format alerts for display. */
  formatAlerts(alerts: Alert[], useMarkdown: boolean = false): string {
    return this.alertSystem.formatAlerts(alerts, useMarkdown);
  }

  /** Format analysis results for display. */
  formatAnalysis(results: TokenAnalysis[]): string {
    const lines: string[] = [];

    // Header
    lines.push("");
    lines.push(chalk.bold("  Sherwood Trading Agent — Analysis Results"));
    lines.push(chalk.dim("  " + "─".repeat(60)));

    // Market regime display (use the first result's regime if available)
    const regime = results[0]?.regime;
    if (regime) {
      const regimeColor = regime.regime === "trending-up" ? chalk.green :
                          regime.regime === "trending-down" ? chalk.red :
                          regime.regime === "ranging" ? chalk.yellow :
                          regime.regime === "high-volatility" ? chalk.magenta :
                          chalk.cyan;

      const regimeStr = regimeColor(regime.regime.toUpperCase().replace('-', ' '));
      const confidenceStr = `${Math.round(regime.confidence * 100)}%`;
      const trendStr = regime.btcTrend === "up" ? chalk.green("↑") :
                       regime.btcTrend === "down" ? chalk.red("↓") :
                       chalk.yellow("→");

      lines.push(`  Market Regime: ${regimeStr} (${confidenceStr} confidence) | BTC trend: ${trendStr} | Volatility: ${regime.volatilityLevel}`);
      lines.push(chalk.dim("  " + "─".repeat(60)));
    }

    // BTC correlation display (use the first non-BTC result's correlation if available)
    const correlation = results.find(r => r.token !== "bitcoin")?.correlation;
    if (correlation) {
      const biasColor = correlation.btcBias === "bullish" ? chalk.green :
                        correlation.btcBias === "bearish" ? chalk.red :
                        chalk.yellow;

      const biasStr = biasColor(correlation.btcBias.toUpperCase());
      const scoreStr = correlation.btcScore >= 0 ? `+${correlation.btcScore.toFixed(2)}` : correlation.btcScore.toFixed(2);

      let suppressionStr = "";
      if (correlation.shouldSuppress && correlation.btcBias === "bearish") {
        const suppressionPct = Math.round((1 - correlation.suppressionFactor) * 100);
        suppressionStr = ` — alt longs suppressed ${suppressionPct}%`;
      } else if (!correlation.shouldSuppress && correlation.btcBias === "bullish") {
        const boostPct = Math.round((correlation.suppressionFactor - 1) * 100);
        if (boostPct > 0) suppressionStr = ` — alt longs boosted ${boostPct}%`;
      }

      lines.push(`  BTC Correlation: ${biasStr} (${scoreStr})${suppressionStr}`);
      lines.push(chalk.dim("  " + "─".repeat(60)));
    }

    lines.push("");

    // Column headers
    const header = `  ${"Token".padEnd(14)} ${"Score".padEnd(8)} ${"Action".padEnd(14)} ${"Conf".padEnd(8)} Key Signals`;
    lines.push(chalk.bold(header));
    lines.push(chalk.dim("  " + "─".repeat(80)));

    for (const r of results) {
      const d = r.decision;

      // Color the action
      let actionStr: string;
      switch (d.action) {
        case "STRONG_BUY":
          actionStr = chalk.bgGreen.black(" STRONG BUY ");
          break;
        case "BUY":
          actionStr = chalk.green("BUY");
          break;
        case "HOLD":
          actionStr = chalk.yellow("HOLD");
          break;
        case "SELL":
          actionStr = chalk.red("SELL");
          break;
        case "STRONG_SELL":
          actionStr = chalk.bgRed.white(" STRONG SELL ");
          break;
      }

      // Score with color
      const scoreColor = d.score > 0.3 ? chalk.green : d.score < -0.3 ? chalk.red : chalk.yellow;
      const scoreStr = scoreColor(d.score.toFixed(3).padStart(7));

      // Confidence
      const confStr = `${(d.confidence * 100).toFixed(0)}%`;

      // Key signals (first 2)
      const keySignals = d.signals
        .filter((s) => Math.abs(s.value) > 0.1)
        .slice(0, 2)
        .map((s) => {
          const v = s.value;
          const color = v > 0 ? chalk.green : v < 0 ? chalk.red : chalk.yellow;
          return color(`${s.source}: ${v > 0 ? "+" : ""}${v.toFixed(2)}`);
        })
        .join(", ");

      lines.push(
        `  ${r.token.padEnd(14)} ${scoreStr} ${actionStr.padEnd(14)} ${confStr.padEnd(8)} ${keySignals}`,
      );
    }

    lines.push("");
    lines.push(chalk.dim(`  Generated at ${new Date().toISOString()}`));
    lines.push("");

    return lines.join("\n");
  }
}
