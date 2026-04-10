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
} from "./scoring.js";
import type { Signal, ScoringWeights, TradeDecision } from "./scoring.js";
import { runStrategies } from "./strategies/index.js";
import { DexScreenerProvider } from "../providers/data/dexscreener.js";
import { FundingRateProvider } from "../providers/data/funding-rate.js";
import { TokenUnlocksProvider } from "../providers/data/token-unlocks.js";
import { TwitterSentimentProvider } from "../providers/data/twitter.js";
import { HyperliquidProvider } from "../providers/data/hyperliquid.js";
import type { StrategyContext, StrategyConfig } from "./strategies/index.js";
import { MarketRegimeDetector } from "./regime.js";
import type { RegimeAnalysis } from "./regime.js";
import { CorrelationGuard } from "./correlation.js";
import type { CorrelationCheck } from "./correlation.js";
import { AlertSystem } from "./alerts.js";
import type { Alert } from "./alerts.js";

export type { Signal, ScoringWeights, TradeDecision, Alert, TechnicalSignals };

export interface AgentConfig {
  tokens: string[];
  cycle: "15m" | "1h" | "4h";
  dryRun: boolean;
  maxPositionPct: number;
  maxRiskPct: number;
  weights?: ScoringWeights;
  /** When true, includes paid x402 data (Nansen smart-money, Messari fundamentals) in analysis. */
  useX402?: boolean;
  /** Per-strategy configuration overrides. */
  strategyConfigs?: Record<string, StrategyConfig>;
}

export interface TokenAnalysis {
  token: string;
  decision: TradeDecision;
  data: {
    technicalSignals?: TechnicalSignals;
    fearAndGreed?: number;
    tvl?: number;
  };
  regime?: RegimeAnalysis;
  correlation?: CorrelationCheck;
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
  }

  /** Analyze a single token — gather all data and score. */
  async analyzeToken(tokenId: string): Promise<TokenAnalysis> {
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
    } else if (ohlcResult.status === 'rejected') {
      console.error(chalk.dim(`  Technical analysis failed for ${tokenId}: ${ohlcResult.reason}`));
    }

    // Process Fear & Greed results
    if (fearGreedResult.status === 'fulfilled' && fearGreedResult.value?.length > 0) {
      const fgData = fearGreedResult.value;
      fearAndGreedValue = fgData[0]!.value;
      const values = fgData.map((d) => d.value);
      sentimentZScore = this.sentiment.computeSentimentZScore(values);
      signals.push(scoreSentiment(fearAndGreedValue, sentimentZScore));
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

    // Phase 2: Parallel research data fetching (Nansen + Messari) if x402 enabled
    if (this.config.useX402) {
      const [nansenResult, messariResult] = await Promise.allSettled([
        // 4. Smart-money & on-chain data (via Nansen x402)
        getResearchProvider("nansen").query({ type: "smart-money", target: tokenId }),

        // 5. Fundamentals & events (via Messari x402)
        getResearchProvider("messari").query({ type: "token", target: tokenId })
      ]);

      // Process Nansen results
      if (nansenResult.status === 'fulfilled') {
        const smResult = nansenResult.value;
        nansenData = smResult.data;
        const flows = smResult.data.flows as Array<Record<string, unknown>> | undefined;
        if (flows && flows.length > 0) {
          // Interpret net flow: negative = leaving exchanges = bullish
          const netflow = flows.reduce((sum, f) => sum + (Number(f.netflow ?? f.net_flow ?? 0)), 0);
          signals.push(scoreOnChain({
            exchangeNetFlow: netflow,
            whaleAccumulating: netflow < 0,
          }));
        } else {
          signals.push(scoreOnChain({}));
        }
        console.error(chalk.dim(`  x402 Nansen smart-money: cost ${smResult.costUsdc} USDC`));
      } else {
        console.error(chalk.dim(`  x402 Nansen smart-money unavailable: ${nansenResult.reason} — using free data only`));
        signals.push(scoreOnChain({}));
      }

      // Process Messari results
      if (messariResult.status === 'fulfilled') {
        const tokenResult = messariResult.value;
        messariData = tokenResult.data;
        const d = tokenResult.data as Record<string, unknown>;
        const metrics = d.metrics as Record<string, unknown> | undefined;
        const profile = d.profile as Record<string, unknown> | undefined;

        // Extract fundamental metrics from Messari data (replaces TVL-based fundamental if present)
        const mcapToTvl = metrics
          ? Number((metrics as Record<string, unknown>).mcap_to_tvl ?? 0) || undefined
          : undefined;

        // Remove any previously-pushed fundamental signal (from phase 1 TVL) to avoid duplicates
        const existingFundIdx = signals.findIndex(s => s.name === "fundamental");
        if (existingFundIdx >= 0) signals.splice(existingFundIdx, 1);

        if (mcapToTvl || metrics) {
          signals.push(scoreFundamental({ mcapToTvl }));
        } else {
          signals.push(scoreFundamental({}));
        }

        // Use profile/category data as an event signal
        const hasPositiveCatalyst = profile
          ? Boolean((profile as Record<string, unknown>).is_verified || (profile as Record<string, unknown>).tag_names)
          : false;
        signals.push(scoreEvent({ positiveEvent: hasPositiveCatalyst || undefined }));

        console.error(chalk.dim(`  x402 Messari token: cost ${tokenResult.costUsdc} USDC`));
      } else {
        console.error(chalk.dim(`  x402 Messari unavailable: ${messariResult.reason} — using free data only`));
        // Fall back: fundamental was already pushed from TVL above only if no TVL
        if (!signals.some(s => s.name === "fundamental")) {
          signals.push(scoreFundamental({}));
        }
        signals.push(scoreEvent({}));
      }
    } else {
      // Only push fundamental if not already pushed from TVL data (phase 1)
      if (!signals.some(s => s.name === "fundamental")) {
        signals.push(scoreFundamental({}));
      }
      signals.push(scoreEvent({}));
    }

    // Phase 3: Parallel strategy data fetching (symbol, funding rate, unlocks)
    let marketData: any = undefined;

    try {
      const [symbolResult, fundingRateResult, unlockResult, twitterResult] = await Promise.allSettled([
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

        // Fetch Twitter sentiment data (free tier with auth)
        this.twitter.getSentiment(tokenId)
      ]);

      // Process symbol/market data results
      let tokenSymbol: string | undefined;
      if (symbolResult.status === 'fulfilled' && symbolResult.value) {
        tokenSymbol = symbolResult.value.symbol;
        marketData = symbolResult.value.marketData;
      }

      // Process funding rate results
      let fundingRateData: StrategyContext['fundingRateData'] = undefined;
      if (fundingRateResult.status === 'fulfilled' && fundingRateResult.value) {
        const fr = fundingRateResult.value;
        fundingRateData = { rate8h: fr.rate8h, annualizedRate: fr.annualizedRate, exchange: fr.exchange };
      }

      // Process unlock results
      let unlockData: StrategyContext['unlockData'] = undefined;
      if (unlockResult.status === 'fulfilled' && unlockResult.value) {
        unlockData = unlockResult.value;
      }

      // Process Twitter results
      let twitterData: StrategyContext['twitterData'] = undefined;
      if (twitterResult.status === 'fulfilled' && twitterResult.value) {
        twitterData = twitterResult.value;
      } else if (twitterResult.status === 'rejected') {
        console.error(chalk.dim(`  Twitter sentiment failed: ${twitterResult.reason}`));
      }

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

      const strategySignals = await runStrategies(stratCtx, this.config.strategyConfigs);

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

    // 8. Compute decision with regime adjustments and correlation suppression
    const decision = computeTradeDecision(
      signals,
      this.config.weights ?? DEFAULT_WEIGHTS,
      regimeAnalysis?.strategyAdjustments,
      correlationCheck
    );

    return {
      token: tokenId,
      decision,
      data: { technicalSignals, fearAndGreed: fearAndGreedValue, tvl },
      regime: regimeAnalysis,
      correlation: correlationCheck,
    };
  }

  /** Update the token watchlist without recreating the agent (preserves caches). */
  updateTokens(tokens: string[]): void {
    this.config.tokens = tokens;
  }

  /** Analyze all watchlist tokens. */
  async analyzeAll(): Promise<TokenAnalysis[]> {
    const results: TokenAnalysis[] = [];
    for (const token of this.config.tokens) {
      const result = await this.analyzeToken(token);
      results.push(result);
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
