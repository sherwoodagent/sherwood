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

export class MarketRegimeDetector {
  private cacheDir: string;
  private cacheFile: string;

  constructor() {
    this.cacheDir = join(homedir(), '.sherwood', 'agent', 'cache');
    this.cacheFile = join(this.cacheDir, 'regime.json');
  }

  /**
   * Detect current market regime using BTC candles.
   * Returns cached result if less than 5 minutes old.
   */
  async detect(btcCandles: Candle[]): Promise<RegimeAnalysis> {
    // Check cache first
    try {
      const cached = await this.loadCache();
      const now = Date.now();
      const cacheAge = now - cached.timestamp;
      // 5-minute TTL — cycles run every ~25min, but a 15min cache lagged real
      // regime shifts by up to a full cycle. 5min keeps the cache useful for
      // back-to-back short scans while staying close to live state.
      const CACHE_DURATION = 5 * 60 * 1000;

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
    if (candles.length < 60) {
      return this.fallbackAnalysis("Insufficient BTC data for regime analysis");
    }

    const closes = candles.map((c) => c.close);
    const currentPrice = closes[closes.length - 1]!;

    // ── Fast momentum override — shared with analyzeBtc ──
    const momentumResult = this.checkMomentumOverride(candles, currentPrice);
    if (momentumResult) return momentumResult;

    // ── Standard EMA/ADX regime classification ──
    // Apr 2026 audit: switched from EMA(50,200) + ADX(14) to EMA(21,50) + ADX(7).
    // On 4h candles EMA(50,200) lagged 200+ hours — missed the Apr 13-14 BTC rally
    // entirely. Faster EMAs + ADX(7) respond in ~28-50 hours instead.
    const ema21 = calculateEMA(closes, 21);
    const ema50 = calculateEMA(closes, 50);
    const currentEma21 = this.getLastValidValue(ema21);
    const currentEma50 = this.getLastValidValue(ema50);

    const bb = calculateBollingerBands(candles, 20, 2.0);
    const currentBbWidth = this.getLastValidValue(bb.width);

    const atr = calculateATR(candles, 14);
    const currentAtr = this.getLastValidValue(atr);
    const atrRatio = currentAtr / currentPrice;

    const adx = this.calculateADX(candles, 7);
    const currentAdx = this.getLastValidValue(adx);

    let btcTrend: RegimeAnalysis["btcTrend"] = "neutral";
    if (!isNaN(currentEma21) && !isNaN(currentEma50)) {
      if (currentPrice > currentEma21 && currentEma21 > currentEma50) {
        btcTrend = "up";
      } else if (currentPrice < currentEma21 && currentEma21 < currentEma50) {
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
    } else if (volatilityLevel === "low" && currentAdx < 15) {
      regime = "low-volatility";
      confidence = 0.8;
      details = `Low volatility (BB ${currentBbWidth.toFixed(3)}, ADX ${currentAdx.toFixed(1)})`;
    } else {
      if (currentAdx > 20 && btcTrend !== "neutral") {
        if (btcTrend === "up") {
          regime = "trending-up";
          confidence = Math.min(0.9, 0.6 + (currentAdx - 20) * 0.01);
          details = `Strong uptrend (ADX ${currentAdx.toFixed(1)})`;
        } else {
          regime = "trending-down";
          confidence = Math.min(0.9, 0.6 + (currentAdx - 20) * 0.01);
          details = `Strong downtrend (ADX ${currentAdx.toFixed(1)})`;
        }
      } else {
        regime = "ranging";
        confidence = currentAdx < 15 ? 0.7 : 0.5;
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
    // Delegate to the synchronous classifier — the async BTC dominance
    // fetch was dead code (checked absolute level, not trend; result
    // only appended to details string, never used in classification).
    return this.classifySync(candles);
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

  /**
   * Fast momentum check — catches intraday trends that EMA/ADX miss.
   * Returns a RegimeAnalysis if momentum override fires, or null to fall
   * through to the standard EMA/ADX classification.
   *
   * Threshold is volatility-adjusted: 1.5× the 14-candle ATR as a
   * percentage of current price, floored at 2% and capped at 8%.
   * - BTC (daily ATR ~2%): threshold ≈ 3% — same as before
   * - SOL (daily ATR ~5%): threshold ≈ 7.5% — avoids false triggers on normal alt vol
   * - FARTCOIN (daily ATR ~10%): threshold = 8% cap — only fires on genuinely unusual moves
   *
   * Requirements for trending-up: price above threshold AND in the upper
   * half of the range (prevents false positives on bounces within a larger
   * downtrend). Symmetric for trending-down.
   */
  private checkMomentumOverride(candles: Candle[], currentPrice: number): RegimeAnalysis | null {
    const MOMENTUM_LOOKBACK = 24;
    const MIN_THRESHOLD = 0.02; // floor: 2%
    const MAX_THRESHOLD = 0.08; // cap: 8%
    const ATR_MULTIPLIER = 1.5;

    // Compute 14-period ATR as a percentage of current price for vol-adjustment
    const atrValues = calculateATR(candles, 14);
    const currentAtr = this.getLastValidValue(atrValues);
    const atrPct = currentPrice > 0 && !isNaN(currentAtr) ? currentAtr / currentPrice : 0.02;
    const threshold = Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, atrPct * ATR_MULTIPLIER));

    // Compute volatility level BEFORE the override so it propagates
    // into the returned RegimeAnalysis. Previously hardcoded "normal"
    // which masked extreme volatility during fast moves.
    const bb = calculateBollingerBands(candles, 20, 2.0);
    const currentBbWidth = this.getLastValidValue(bb.width);
    let volLevel: RegimeAnalysis["volatilityLevel"] = "normal";
    if (!isNaN(currentBbWidth)) {
      if (currentBbWidth < 0.04) volLevel = "low";
      else if (currentBbWidth > 0.20) volLevel = "extreme";
      else if (currentBbWidth > 0.10) volLevel = "high";
    }

    const recentCandles = candles.slice(-MOMENTUM_LOOKBACK);
    const recentLow = Math.min(...recentCandles.map((c) => c.low));
    const recentHigh = Math.max(...recentCandles.map((c) => c.high));
    const pctAboveLow = recentLow > 0 ? (currentPrice - recentLow) / recentLow : 0;
    const pctBelowHigh = recentHigh > 0 ? (recentHigh - currentPrice) / recentHigh : 0;

    const recentMid = (recentHigh + recentLow) / 2;
    const inUpperHalf = currentPrice >= recentMid;
    const inLowerHalf = currentPrice <= recentMid;

    if (pctAboveLow >= threshold && inUpperHalf) {
      return {
        regime: "trending-up",
        confidence: Math.min(0.85, 0.5 + pctAboveLow * 5),
        btcTrend: "up",
        volatilityLevel: volLevel,
        details: `Momentum override: price +${(pctAboveLow * 100).toFixed(1)}% above ${MOMENTUM_LOOKBACK}-candle low (threshold ${(threshold * 100).toFixed(1)}%, ATR-adjusted)`,
        strategyAdjustments: this.getStrategyAdjustments("trending-up"),
      };
    }
    if (pctBelowHigh >= threshold && inLowerHalf) {
      return {
        regime: "trending-down",
        confidence: Math.min(0.85, 0.5 + pctBelowHigh * 5),
        btcTrend: "down",
        volatilityLevel: volLevel,
        details: `Momentum override: price -${(pctBelowHigh * 100).toFixed(1)}% below ${MOMENTUM_LOOKBACK}-candle high (threshold ${(threshold * 100).toFixed(1)}%, ATR-adjusted)`,
        strategyAdjustments: this.getStrategyAdjustments("trending-down"),
      };
    }
    return null;
  }

  private getStrategyAdjustments(regime: MarketRegime): Record<string, number> {
    // Only active strategies. Trend-aligned signals boosted during trends,
    // contrarian signals boosted during ranging.
    const baseMultipliers: Record<MarketRegime, Record<string, number>> = {
      "trending-up": {
        breakoutOnChain: 1.3,
        fundingRate: 1.0,
        dexFlow: 1.2,
        sentimentContrarian: 0.7,
        hyperliquidFlow: 1.2,
        multiTimeframe: 1.2,
        crossSectionalMomentum: 1.2,
        tradingviewSignal: 1.0,
      },
      "trending-down": {
        breakoutOnChain: 1.3,
        fundingRate: 1.2,
        dexFlow: 1.2,
        sentimentContrarian: 0.8,
        hyperliquidFlow: 1.3,
        multiTimeframe: 1.2,
        crossSectionalMomentum: 1.2,
        tradingviewSignal: 1.0,
      },
      "ranging": {
        breakoutOnChain: 0.5,
        fundingRate: 1.0,
        dexFlow: 0.8,
        sentimentContrarian: 1.3,
        hyperliquidFlow: 1.0,
        multiTimeframe: 0.8,
        crossSectionalMomentum: 1.0,
        tradingviewSignal: 1.0,
      },
      "high-volatility": {
        breakoutOnChain: 1.0,
        fundingRate: 1.0,
        dexFlow: 0.7,
        sentimentContrarian: 0.7,
        hyperliquidFlow: 0.7,
        multiTimeframe: 0.7,
        crossSectionalMomentum: 0.8,
        tradingviewSignal: 0.8,
      },
      "low-volatility": {
        breakoutOnChain: 1.3,
        fundingRate: 0.8,
        dexFlow: 0.8,
        sentimentContrarian: 0.8,
        hyperliquidFlow: 0.8,
        multiTimeframe: 1.2,
        crossSectionalMomentum: 1.0,
        tradingviewSignal: 1.0,
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
        fundingRate: 1.0,
        dexFlow: 1.0,
        sentimentContrarian: 1.0,
        hyperliquidFlow: 1.0,
        multiTimeframe: 1.0,
        crossSectionalMomentum: 1.0,
        tradingviewSignal: 1.0,
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