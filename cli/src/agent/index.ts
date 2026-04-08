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
import type { StrategyContext, StrategyConfig } from "./strategies/index.js";

export type { Signal, ScoringWeights, TradeDecision };

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
}

export class TradingAgent {
  private config: AgentConfig;
  private defillama: DefiLlamaProvider;
  private coingecko: CoinGeckoProvider;
  private sentiment: SentimentProvider;
  private dexscreener: DexScreenerProvider;

  constructor(config: AgentConfig) {
    this.config = config;
    this.defillama = new DefiLlamaProvider();
    this.coingecko = new CoinGeckoProvider();
    this.sentiment = new SentimentProvider();
    this.dexscreener = new DexScreenerProvider();
  }

  /** Analyze a single token — gather all data and score. */
  async analyzeToken(tokenId: string): Promise<TokenAnalysis> {
    const signals: Signal[] = [];
    let technicalSignals: TechnicalSignals | undefined;
    let fearAndGreedValue: number | undefined;
    let tvl: number | undefined;
    let candles: Candle[] | undefined;
    let sentimentZScore: number | undefined;

    // 1. Fetch OHLC data from CoinGecko and calculate technical indicators
    try {
      const ohlcRaw = await this.coingecko.getOHLC(tokenId, 30);
      if (ohlcRaw && ohlcRaw.length > 10) {
        candles = ohlcRaw.map((c: number[]) => ({
          timestamp: c[0]!,
          open: c[1]!,
          high: c[2]!,
          low: c[3]!,
          close: c[4] ?? c[3]!, // CoinGecko OHLC: [ts, o, h, l, c]
          volume: 0, // OHLC endpoint doesn't include volume
        }));

        // Fetch market data for volume info
        try {
          const marketData = await this.coingecko.getMarketData(tokenId, 30);
          if (marketData?.total_volumes) {
            // Map volumes to nearest candle by timestamp
            for (const candle of candles) {
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

        technicalSignals = getLatestSignals(candles);
        signals.push(scoreTechnical(technicalSignals));
      }
    } catch (err) {
      // Technical analysis failed, continue with other signals
      console.error(chalk.dim(`  Technical analysis failed for ${tokenId}: ${(err as Error).message}`));
    }

    // 2. Fetch Fear & Greed
    try {
      const fgData = await this.sentiment.getFearAndGreed();
      if (fgData.length > 0) {
        fearAndGreedValue = fgData[0]!.value;
        const values = fgData.map((d) => d.value);
        sentimentZScore = this.sentiment.computeSentimentZScore(values);
        signals.push(scoreSentiment(fearAndGreedValue, sentimentZScore));
      }
    } catch (err) {
      console.error(chalk.dim(`  Sentiment data failed: ${(err as Error).message}`));
    }

    // 3. Fetch TVL data (if DeFi protocol)
    try {
      tvl = await this.defillama.getProtocolTvl(tokenId);
      if (typeof tvl === "number" && tvl > 0) {
        // Try to get price data for mcap/tvl ratio
        const priceData = await this.coingecko.getPrice([tokenId], ["usd"]);
        const mcap = priceData?.[tokenId]?.usd_market_cap;
        signals.push(
          scoreFundamental({
            mcapToTvl: mcap && tvl > 0 ? mcap / tvl : undefined,
          }),
        );
      }
    } catch {
      // Not all tokens have TVL data, that's fine
      signals.push(scoreFundamental({}));
    }

    // 4. Smart-money & on-chain data (via Nansen x402 when enabled)
    if (this.config.useX402) {
      try {
        const nansen = getResearchProvider("nansen");
        const smResult = await nansen.query({ type: "smart-money", target: tokenId });
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
      } catch (err) {
        console.error(chalk.dim(`  x402 Nansen smart-money unavailable: ${(err as Error).message} — using free data only`));
        signals.push(scoreOnChain({}));
      }
    } else {
      signals.push(scoreOnChain({}));
    }

    // 5. Fundamentals & events (via Messari x402 when enabled)
    if (this.config.useX402) {
      try {
        const messari = getResearchProvider("messari");
        const tokenResult = await messari.query({ type: "token", target: tokenId });
        const d = tokenResult.data as Record<string, unknown>;
        const metrics = d.metrics as Record<string, unknown> | undefined;
        const profile = d.profile as Record<string, unknown> | undefined;

        // Extract fundamental metrics from Messari data (replaces TVL-based fundamental if present)
        const mcapToTvl = metrics
          ? Number((metrics as Record<string, unknown>).mcap_to_tvl ?? 0) || undefined
          : undefined;

        // Remove any previously-pushed fundamental signal (from step 3 TVL) to avoid duplicates
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
      } catch (err) {
        console.error(chalk.dim(`  x402 Messari unavailable: ${(err as Error).message} — using free data only`));
        // Fall back: fundamental was already pushed from TVL above only if no TVL
        if (!signals.some(s => s.name === "fundamental")) {
          signals.push(scoreFundamental({}));
        }
        signals.push(scoreEvent({}));
      }
    } else {
      // Only push fundamental if not already pushed from TVL data (step 3)
      if (!signals.some(s => s.name === "fundamental")) {
        signals.push(scoreFundamental({}));
      }
      signals.push(scoreEvent({}));
    }

    // 6. Run strategy modules for additional signals
    let nansenData: any = undefined;
    let messariData: any = undefined;
    let marketData: any = undefined;

    try {
      // Resolve token symbol from CoinGecko for accurate DEX search
      let tokenSymbol: string | undefined;
      try {
        const coinDetails = await this.coingecko.getCoinDetails(tokenId);
        tokenSymbol = coinDetails?.symbol?.toUpperCase();
        // Also get market data for strategies
        marketData = await this.coingecko.getMarketData(tokenId, 7);
      } catch {
        // symbol resolution failed — strategies will fall back to static map
      }

      // Re-fetch research data for strategies if x402 is enabled
      if (this.config.useX402) {
        try {
          const nansen = getResearchProvider("nansen");
          const smResult = await nansen.query({ type: "smart-money", target: tokenId });
          nansenData = smResult.data;
        } catch {
          // Nansen data optional for strategies
        }

        try {
          const messari = getResearchProvider("messari");
          const tokenResult = await messari.query({ type: "token", target: tokenId });
          messariData = tokenResult.data;
        } catch {
          // Messari data optional for strategies
        }
      }

      const stratCtx: StrategyContext = {
        tokenId,
        candles, // reuse from step 1
        technicals: technicalSignals,
        fearAndGreed: fearAndGreedValue !== undefined
          ? { value: fearAndGreedValue, classification: fearAndGreedValue < 25 ? 'fear' : fearAndGreedValue > 75 ? 'greed' : 'neutral' }
          : undefined,
        sentimentZScore, // reuse from step 2
        tvlData: tvl,
        marketData,
        nansenData,
        messariData,
        dexData: undefined, // DexFlowStrategy fetches this internally
        tokenSymbol,
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

    // 7. Compute decision
    const decision = computeTradeDecision(signals, this.config.weights ?? DEFAULT_WEIGHTS);

    return { token: tokenId, decision, data: { technicalSignals, fearAndGreed: fearAndGreedValue, tvl } };
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

  /** Format analysis results for display. */
  formatAnalysis(results: TokenAnalysis[]): string {
    const lines: string[] = [];

    // Header
    lines.push("");
    lines.push(chalk.bold("  Sherwood Trading Agent — Analysis Results"));
    lines.push(chalk.dim("  " + "─".repeat(60)));
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
