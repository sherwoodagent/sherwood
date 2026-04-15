/**
 * Market regime detection module — analyzes BTC to classify market state.
 * Helps adjust strategy confidence based on current macro conditions.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Candle } from "./technical.js";
import { calculateEMA, calculateBollingerBands, calculateATR } from "./technical.js";

export type MarketRegime = "trending-up" | "trending-down" | "ranging" | "high-volatility" | "low-volatility";

export interface RegimeAnalysis {
  regime: MarketRegime;
  confidence: number;        // 0-1 how sure we are about the regime
  btcTrend: "up" | "down" | "neutral";
  volatilityLevel: "low" | "normal" | "high" | "extreme";
  details: string;
  strategyAdjustments: Record<string, number>; // multiplier per strategy name (0.0 to 1.5)
}

interface RegimeCache {
  timestamp: number;
  analysis: RegimeAnalysis;
}

interface BtcDominanceData {
  market_cap_percentage: {
    btc: number;
  };
}

export class MarketRegimeDetector {
  private cacheDir: string;
  private cacheFile: string;

  constructor() {
    this.cacheDir = join(homedir(), '.sherwood', 'agent', 'cache');
    this.cacheFile = join(this.cacheDir, 'regime.json');
  }

  /**
   * Detect current market regime using BTC candles.
   * Returns cached result if less than 15 minutes old.
   */
  async detect(btcCandles: Candle[]): Promise<RegimeAnalysis> {
    // Check cache first
    try {
      const cached = await this.loadCache();
      const now = Date.now();
      const cacheAge = now - cached.timestamp;
      const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes

      if (cacheAge < CACHE_DURATION) {
        return cached.analysis;
      }
    } catch {
      // Cache miss or invalid, continue to fresh analysis
    }

    const analysis = await this.analyzeBtc(btcCandles);

    // Save to cache
    try {
      await this.saveCache(analysis);
    } catch {
      // Non-critical, continue without caching
    }

    return analysis;
  }

  /**
   * Pure regime classification from a candle window — no network calls,
   * no cache, no BTC dominance lookup. Use this from the backtester to
   * compute regime per-candle without look-ahead bias or external IO.
   */
  static classifyFromCandles(candles: Candle[]): RegimeAnalysis {
    const detector = new MarketRegimeDetector();
    return detector.classifySync(candles);
  }

  /** Synchronous candle-only analysis — same logic as analyzeBtc minus dominance/IO. */
  classifySync(candles: Candle[]): RegimeAnalysis {
    if (candles.length < 200) {
      return this.fallbackAnalysis("Insufficient BTC data for regime analysis");
    }

    const closes = candles.map((c) => c.close);
    const currentPrice = closes[closes.length - 1]!;

    const ema50 = calculateEMA(closes, 50);
    const ema200 = calculateEMA(closes, 200);
    const currentEma50 = this.getLastValidValue(ema50);
    const currentEma200 = this.getLastValidValue(ema200);

    const bb = calculateBollingerBands(candles, 20, 2.0);
    const currentBbWidth = this.getLastValidValue(bb.width);

    const atr = calculateATR(candles, 14);
    const currentAtr = this.getLastValidValue(atr);
    const atrRatio = currentAtr / currentPrice;

    const adx = this.calculateADX(candles, 14);
    const currentAdx = this.getLastValidValue(adx);

    let btcTrend: RegimeAnalysis["btcTrend"] = "neutral";
    if (!isNaN(currentEma50) && !isNaN(currentEma200)) {
      if (currentPrice > currentEma50 && currentEma50 > currentEma200) {
        btcTrend = "up";
      } else if (currentPrice < currentEma50 && currentEma50 < currentEma200) {
        btcTrend = "down";
      }
    }

    let volatilityLevel: RegimeAnalysis["volatilityLevel"] = "normal";
    if (!isNaN(currentBbWidth)) {
      if (currentBbWidth < 0.04) volatilityLevel = "low";
      else if (currentBbWidth > 0.20) volatilityLevel = "extreme";
      else if (currentBbWidth > 0.10) volatilityLevel = "high";
    }

    let regime: MarketRegime;
    let confidence: number;
    let details: string;

    if (volatilityLevel === "extreme") {
      regime = "high-volatility";
      confidence = 0.9;
      details = `Extreme volatility (BB ${currentBbWidth.toFixed(3)}, ATR ${atrRatio.toFixed(3)})`;
    } else if (volatilityLevel === "low" && currentAdx < 20) {
      regime = "low-volatility";
      confidence = 0.8;
      details = `Low volatility (BB ${currentBbWidth.toFixed(3)}, ADX ${currentAdx.toFixed(1)})`;
    } else {
      if (currentAdx > 25 && btcTrend !== "neutral") {
        if (btcTrend === "up") {
          regime = "trending-up";
          confidence = Math.min(0.9, 0.6 + (currentAdx - 25) * 0.01);
          details = `Strong uptrend (ADX ${currentAdx.toFixed(1)})`;
        } else {
          regime = "trending-down";
          confidence = Math.min(0.9, 0.6 + (currentAdx - 25) * 0.01);
          details = `Strong downtrend (ADX ${currentAdx.toFixed(1)})`;
        }
      } else {
        regime = "ranging";
        confidence = currentAdx < 20 ? 0.7 : 0.5;
        details = `Ranging (ADX ${currentAdx.toFixed(1)})`;
      }
    }

    return {
      regime,
      confidence,
      btcTrend,
      volatilityLevel,
      details,
      strategyAdjustments: this.getStrategyAdjustments(regime),
    };
  }

  private async analyzeBtc(candles: Candle[]): Promise<RegimeAnalysis> {
    if (candles.length < 200) {
      return this.fallbackAnalysis("Insufficient BTC data for regime analysis");
    }

    const closes = candles.map(c => c.close);
    const currentPrice = closes[closes.length - 1]!;

    // Calculate EMAs for trend detection
    const ema50 = calculateEMA(closes, 50);
    const ema200 = calculateEMA(closes, 200);
    const currentEma50 = this.getLastValidValue(ema50);
    const currentEma200 = this.getLastValidValue(ema200);

    // Calculate Bollinger Bands for volatility
    const bb = calculateBollingerBands(candles, 20, 2.0);
    const currentBbWidth = this.getLastValidValue(bb.width);

    // Calculate ATR for additional volatility measure
    const atr = calculateATR(candles, 14);
    const currentAtr = this.getLastValidValue(atr);
    const atrRatio = currentAtr / currentPrice;

    // Calculate ADX for trend strength
    const adx = this.calculateADX(candles, 14);
    const currentAdx = this.getLastValidValue(adx);

    // Fetch BTC dominance (async, with fallback)
    let btcDominanceTrend: "rising" | "falling" | "neutral" = "neutral";
    try {
      btcDominanceTrend = await this.getBtcDominanceTrend();
    } catch {
      // Use default if fetch fails
    }

    // Determine BTC trend
    let btcTrend: RegimeAnalysis["btcTrend"] = "neutral";
    if (!isNaN(currentEma50) && !isNaN(currentEma200)) {
      if (currentPrice > currentEma50 && currentEma50 > currentEma200) {
        btcTrend = "up";
      } else if (currentPrice < currentEma50 && currentEma50 < currentEma200) {
        btcTrend = "down";
      }
    }

    // Determine volatility level
    let volatilityLevel: RegimeAnalysis["volatilityLevel"] = "normal";
    if (!isNaN(currentBbWidth)) {
      if (currentBbWidth < 0.04) {
        volatilityLevel = "low";
      } else if (currentBbWidth > 0.20) {
        volatilityLevel = "extreme";
      } else if (currentBbWidth > 0.10) {
        volatilityLevel = "high";
      }
    }

    // Determine primary regime and confidence
    let regime: MarketRegime;
    let confidence: number;
    let details: string;

    // Volatility regimes take precedence if extreme
    if (volatilityLevel === "extreme") {
      regime = "high-volatility";
      confidence = 0.9;
      details = `Extreme volatility detected (BB width: ${currentBbWidth.toFixed(3)}, ATR: ${atrRatio.toFixed(3)})`;
    } else if (volatilityLevel === "low" && currentAdx < 20) {
      regime = "low-volatility";
      confidence = 0.8;
      details = `Low volatility detected (BB width: ${currentBbWidth.toFixed(3)}, ADX: ${currentAdx.toFixed(1)})`;
    } else {
      // Trend-based regimes
      if (currentAdx > 25 && btcTrend !== "neutral") {
        if (btcTrend === "up") {
          regime = "trending-up";
          confidence = Math.min(0.9, 0.6 + (currentAdx - 25) * 0.01);
          details = `Strong uptrend (ADX: ${currentAdx.toFixed(1)}, EMAs aligned bullish)`;
        } else {
          regime = "trending-down";
          confidence = Math.min(0.9, 0.6 + (currentAdx - 25) * 0.01);
          details = `Strong downtrend (ADX: ${currentAdx.toFixed(1)}, EMAs aligned bearish)`;
        }
      } else {
        regime = "ranging";
        confidence = currentAdx < 20 ? 0.7 : 0.5;
        details = `Ranging market (ADX: ${currentAdx.toFixed(1)}, no clear trend)`;
      }
    }

    // Add BTC dominance context to details
    if (btcDominanceTrend !== "neutral") {
      details += `, BTC dominance ${btcDominanceTrend}`;
    }

    // Generate strategy adjustments based on regime
    const strategyAdjustments = this.getStrategyAdjustments(regime);

    return {
      regime,
      confidence,
      btcTrend,
      volatilityLevel,
      details,
      strategyAdjustments,
    };
  }

  private calculateADX(candles: Candle[], period: number): number[] {
    if (candles.length < period + 1) return [];

    // Calculate True Range and Directional Movement
    const trueRanges: number[] = [];
    const dmPlus: number[] = [];
    const dmMinus: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const curr = candles[i]!;
      const prev = candles[i - 1]!;

      // True Range
      const tr = Math.max(
        curr.high - curr.low,
        Math.abs(curr.high - prev.close),
        Math.abs(curr.low - prev.close)
      );
      trueRanges.push(tr);

      // Directional Movement
      const upMove = curr.high - prev.high;
      const downMove = prev.low - curr.low;

      dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
      dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    // Smooth the values using Wilder's smoothing
    const smoothTR = this.wilderSmooth(trueRanges, period);
    const smoothDMPlus = this.wilderSmooth(dmPlus, period);
    const smoothDMMinus = this.wilderSmooth(dmMinus, period);

    // Calculate DI+ and DI-
    const diPlus: number[] = [];
    const diMinus: number[] = [];
    const dx: number[] = [];

    for (let i = 0; i < smoothTR.length; i++) {
      if (smoothTR[i] > 0) {
        const diP = (smoothDMPlus[i] / smoothTR[i]) * 100;
        const diM = (smoothDMMinus[i] / smoothTR[i]) * 100;
        diPlus.push(diP);
        diMinus.push(diM);

        // Calculate DX
        const diSum = diP + diM;
        if (diSum > 0) {
          dx.push((Math.abs(diP - diM) / diSum) * 100);
        } else {
          dx.push(0);
        }
      } else {
        diPlus.push(0);
        diMinus.push(0);
        dx.push(0);
      }
    }

    // ADX is the smoothed DX
    return this.wilderSmooth(dx, period);
  }

  private wilderSmooth(values: number[], period: number): number[] {
    const result: number[] = [];

    for (let i = 0; i < values.length; i++) {
      if (i < period - 1) {
        result.push(NaN);
      } else if (i === period - 1) {
        // Initial smoothed value is simple average
        const sum = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
        result.push(sum / period);
      } else {
        // Subsequent values use Wilder's smoothing
        const prev = result[i - 1]!;
        const current = values[i]!;
        result.push((prev * (period - 1) + current) / period);
      }
    }

    return result;
  }

  private async getBtcDominanceTrend(): Promise<"rising" | "falling" | "neutral"> {
    try {
      const response = await fetch("https://api.coingecko.com/api/v3/global");
      if (!response.ok) throw new Error("Failed to fetch global data");

      const data = await response.json() as BtcDominanceData;
      const currentDominance = data.market_cap_percentage.btc;

      // This is a simplified trend detection - in production you'd want historical data
      // For now, just use the current value as a neutral baseline
      if (currentDominance > 50) return "rising";
      if (currentDominance < 40) return "falling";
      return "neutral";
    } catch {
      return "neutral";
    }
  }

  private getStrategyAdjustments(regime: MarketRegime): Record<string, number> {
    const baseMultipliers: Record<MarketRegime, Record<string, number>> = {
      "trending-up": {
        breakoutOnChain: 1.3,
        meanReversion: 0.3,
        fundingRate: 1.0,
        dexFlow: 1.2,
        twitterSentiment: 1.0,
        sentimentContrarian: 0.7,
        tvlMomentum: 1.2,
        hyperliquidFlow: 1.2,
      },
      "trending-down": {
        breakoutOnChain: 1.3,
        meanReversion: 0.3,
        fundingRate: 1.2,
        dexFlow: 1.2,
        twitterSentiment: 1.0,
        sentimentContrarian: 0.8,
        tvlMomentum: 0.5,
        hyperliquidFlow: 1.3,
      },
      "ranging": {
        breakoutOnChain: 0.5,
        meanReversion: 1.5,
        fundingRate: 1.0,
        dexFlow: 0.8,
        twitterSentiment: 0.8,
        sentimentContrarian: 1.3,
        tvlMomentum: 1.0,
        hyperliquidFlow: 1.0,
      },
      "high-volatility": {
        breakoutOnChain: 1.0,
        meanReversion: 0.3,
        fundingRate: 1.0,
        dexFlow: 0.7,
        twitterSentiment: 0.7,
        sentimentContrarian: 0.7,
        tvlMomentum: 0.7,
        hyperliquidFlow: 0.7,
      },
      "low-volatility": {
        breakoutOnChain: 1.3,
        meanReversion: 1.2,
        fundingRate: 0.8,
        dexFlow: 0.8,
        twitterSentiment: 0.8,
        sentimentContrarian: 0.8,
        tvlMomentum: 0.8,
        hyperliquidFlow: 0.8,
      },
    };

    return baseMultipliers[regime];
  }

  private getLastValidValue(arr: number[]): number {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!isNaN(arr[i]!)) return arr[i]!;
    }
    return NaN;
  }

  private fallbackAnalysis(reason: string): RegimeAnalysis {
    return {
      regime: "ranging",
      confidence: 0.3,
      btcTrend: "neutral",
      volatilityLevel: "normal",
      details: reason,
      strategyAdjustments: {
        breakoutOnChain: 1.0,
        meanReversion: 1.0,
        fundingRate: 1.0,
        dexFlow: 1.0,
        twitterSentiment: 1.0,
        sentimentContrarian: 1.0,
        tvlMomentum: 1.0,
        hyperliquidFlow: 1.0,
      },
    };
  }

  private async loadCache(): Promise<RegimeCache> {
    const data = await readFile(this.cacheFile, 'utf-8');
    return JSON.parse(data) as RegimeCache;
  }

  private async saveCache(analysis: RegimeAnalysis): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const cache: RegimeCache = {
      timestamp: Date.now(),
      analysis,
    };
    await writeFile(this.cacheFile, JSON.stringify(cache, null, 2), 'utf-8');
  }
}