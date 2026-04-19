/**
 * Correlation guard module — prevents going long on alts when BTC is bearish.
 * Uses BTC technicals to assess market structure and suppress/boost alt signals.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Candle } from "./technical.js";
import { calculateEMA, calculateRSI, calculateMACD } from "./technical.js";
import { CoinGeckoProvider } from "../providers/data/coingecko.js";

export interface CorrelationCheck {
  btcBias: "bullish" | "bearish" | "neutral";
  btcScore: number;        // -1 to +1
  shouldSuppress: boolean; // true if alt long signal should be reduced
  suppressionFactor: number; // 0.0 to 1.0 multiplier on alt signals
  reason: string;
}

interface CorrelationCache {
  timestamp: number;
  btcStructure: BtcStructure;
}

interface BtcStructure {
  price: number;
  ema50: number;
  ema200: number;
  rsi: number;
  macdDirection: "bullish" | "bearish" | "neutral";
  score: number;
}

export class CorrelationGuard {
  private cacheDir: string;
  private cacheFile: string;
  private coingecko: CoinGeckoProvider;

  constructor() {
    this.cacheDir = join(homedir(), '.sherwood', 'agent', 'cache');
    this.cacheFile = join(this.cacheDir, 'btc-correlation.json');
    this.coingecko = new CoinGeckoProvider();
  }

  /**
   * Check correlation and return suppression factors for a given token.
   * BTC itself is never suppressed. Stablecoins are never suppressed.
   */
  async checkCorrelation(tokenId: string): Promise<CorrelationCheck> {
    // Skip correlation check for BTC and stablecoins
    if (this.shouldSkipCorrelation(tokenId)) {
      return this.neutralCheck("BTC or stablecoin - no correlation suppression");
    }

    // Get BTC structure (cached for 10 minutes)
    const btcStructure = await this.getBtcStructure();

    // Determine BTC bias and score
    const { bias, score, reason } = this.assessBtcBias(btcStructure);

    // Calculate suppression for alt tokens
    const { shouldSuppress, suppressionFactor } = this.calculateSuppression(bias, score);

    return {
      btcBias: bias,
      btcScore: score,
      shouldSuppress,
      suppressionFactor,
      reason,
    };
  }

  private shouldSkipCorrelation(tokenId: string): boolean {
    // Skip BTC itself
    if (tokenId === "bitcoin") return true;

    // Skip stablecoins
    const stablecoins = [
      "tether", "usd-coin", "binance-usd", "dai", "frax",
      "trueusd", "paxos-standard", "gemini-dollar", "liquity-usd"
    ];

    return stablecoins.includes(tokenId);
  }

  private async getBtcStructure(): Promise<BtcStructure> {
    // Check cache first. Cache holds successful fetches ONLY — fallback structures
    // (price === 0, returned when CoinGecko throws / 429s) are never persisted, so a
    // rate-limited minute doesn't poison the cache for the next hour.
    let cached: CorrelationCache | undefined;
    try {
      cached = await this.loadCache();
      const cacheAge = Date.now() - cached.timestamp;
      const CACHE_DURATION = 60 * 60 * 1000; // 60 minutes — CG free-tier rate limits
      //                                        punish frequent 90-day OHLC calls.
      // Also skip the cache if the stored structure is a fallback (price === 0).
      // Legacy cache files written before the fallback-caching fix may hold the
      // neutral sentinel; we want to re-attempt the fetch instead of serving it.
      if (cacheAge < CACHE_DURATION && cached.btcStructure.price > 0) {
        return cached.btcStructure;
      }
    } catch {
      // Cache miss or invalid — continue to fresh analysis.
    }

    // Fetch fresh BTC data
    const btcStructure = await this.analyzeBtcStructure();

    // Only cache successful analyses. price === 0 is the fallback sentinel from the
    // catch branch in analyzeBtcStructure — caching it would mean a single CoinGecko
    // 429 sticks the correlation score at neutral for the full TTL window.
    if (btcStructure.price > 0) {
      try {
        await this.saveCache(btcStructure);
      } catch {
        // Non-critical — continue without caching.
      }
      return btcStructure;
    }

    // Fetch failed and the neutral fallback was returned. If we have a stale-but-real
    // cached structure, prefer it over the fallback — the market doesn't regime-shift
    // in a single CG retry window, and a valid-but-stale btcBias is strictly more
    // informative than `price: 0, score: 0`.
    if (cached && cached.btcStructure.price > 0) {
      return cached.btcStructure;
    }

    return btcStructure;
  }

  private async analyzeBtcStructure(): Promise<BtcStructure> {
    try {
      // Fetch BTC candles (90 days for EMAs — CoinGecko returns daily candles at days>=90,
      // giving us ~90 bars, enough for the 50-bar floor required by EMA/RSI/MACD history).
      const ohlcData = await this.coingecko.getOHLC("bitcoin", 90);

      if (!ohlcData || ohlcData.length < 50) {
        throw new Error("Insufficient BTC data");
      }

      const candles: Candle[] = ohlcData.map((c: number[]) => ({
        timestamp: c[0]!,
        open: c[1]!,
        high: c[2]!,
        low: c[3]!,
        close: c[4] ?? c[3]!,
        volume: 0, // Not needed for structure assessment
      }));

      const closes = candles.map(c => c.close);
      const currentPrice = closes[closes.length - 1]!;

      // Calculate technical indicators
      const ema50Array = calculateEMA(closes, 50);
      const ema200Array = calculateEMA(closes, 200);
      const rsiArray = calculateRSI(candles, 14);
      const macd = calculateMACD(candles, 12, 26, 9);

      // Get latest valid values
      const ema50 = this.getLastValidValue(ema50Array);
      const ema200 = this.getLastValidValue(ema200Array);
      const rsi = this.getLastValidValue(rsiArray);
      const macdHistogram = this.getLastValidValue(macd.histogram);

      // Determine MACD direction
      let macdDirection: BtcStructure["macdDirection"] = "neutral";
      if (!isNaN(macdHistogram)) {
        if (macdHistogram > 0.1) macdDirection = "bullish";
        else if (macdHistogram < -0.1) macdDirection = "bearish";
      }

      // Calculate composite score (-1 to +1)
      let score = 0;

      // EMA alignment (40% weight)
      if (!isNaN(ema50) && !isNaN(ema200)) {
        if (currentPrice > ema50 && ema50 > ema200) {
          score += 0.4; // Bullish alignment
        } else if (currentPrice < ema50 && ema50 < ema200) {
          score -= 0.4; // Bearish alignment
        }
        // Neutral if mixed
      }

      // RSI (30% weight)
      if (!isNaN(rsi)) {
        if (rsi < 40) {
          score += 0.3; // Oversold = potentially bullish
        } else if (rsi > 60) {
          score -= 0.3; // Overbought = potentially bearish
        }
        // Scale linearly between 40-60
        else {
          const rsiScore = -((rsi - 50) / 10) * 0.15; // Max ±0.15 in neutral range
          score += rsiScore;
        }
      }

      // MACD direction (30% weight)
      if (macdDirection === "bullish") {
        score += 0.3;
      } else if (macdDirection === "bearish") {
        score -= 0.3;
      }

      // Clamp score to [-1, 1]
      score = Math.max(-1, Math.min(1, score));

      return {
        price: currentPrice,
        ema50: isNaN(ema50) ? 0 : ema50,
        ema200: isNaN(ema200) ? 0 : ema200,
        rsi: isNaN(rsi) ? 50 : rsi,
        macdDirection,
        score,
      };

    } catch (error) {
      console.warn(`BTC structure analysis failed: ${(error as Error).message}`);

      // Return neutral structure on failure
      return {
        price: 0,
        ema50: 0,
        ema200: 0,
        rsi: 50,
        macdDirection: "neutral",
        score: 0,
      };
    }
  }

  private assessBtcBias(structure: BtcStructure): { bias: CorrelationCheck["btcBias"], score: number, reason: string } {
    const score = structure.score;

    if (score < -0.3) {
      const components = [];
      if (structure.price > 0 && structure.ema50 > 0 && structure.ema200 > 0) {
        if (structure.price < structure.ema50 && structure.ema50 < structure.ema200) {
          components.push("below EMAs");
        }
      }
      if (structure.rsi < 40) components.push(`RSI ${structure.rsi.toFixed(1)}`);
      if (structure.macdDirection === "bearish") components.push("MACD bearish");

      return {
        bias: "bearish",
        score,
        reason: `BTC bearish (${score.toFixed(2)}) — ${components.join(", ") || "weak structure"}`,
      };
    }

    if (score > 0.3) {
      const components = [];
      if (structure.price > 0 && structure.ema50 > 0 && structure.ema200 > 0) {
        if (structure.price > structure.ema50 && structure.ema50 > structure.ema200) {
          components.push("above EMAs");
        }
      }
      if (structure.rsi > 60) components.push(`RSI ${structure.rsi.toFixed(1)}`);
      if (structure.macdDirection === "bullish") components.push("MACD bullish");

      return {
        bias: "bullish",
        score,
        reason: `BTC bullish (${score.toFixed(2)}) — ${components.join(", ") || "strong structure"}`,
      };
    }

    return {
      bias: "neutral",
      score,
      reason: `BTC neutral (${score.toFixed(2)}) — mixed signals`,
    };
  }

  private calculateSuppression(bias: CorrelationCheck["btcBias"], score: number): { shouldSuppress: boolean, suppressionFactor: number } {
    if (bias === "bearish") {
      // Strong bearish: suppress longs heavily, boost shorts slightly
      const suppressionFactor = 1 + score; // score is negative, so this reduces the factor
      return {
        shouldSuppress: true,
        suppressionFactor: Math.max(0.1, suppressionFactor), // Min 10% of original signal
      };
    }

    if (bias === "bullish") {
      // Strong bullish: boost longs slightly, suppress shorts
      const boostFactor = 1 + score * 0.2; // Max 20% boost for longs
      return {
        shouldSuppress: false,
        suppressionFactor: Math.min(1.2, boostFactor), // Max 20% boost
      };
    }

    // Neutral: no suppression
    return {
      shouldSuppress: false,
      suppressionFactor: 1.0,
    };
  }

  private neutralCheck(reason: string): CorrelationCheck {
    return {
      btcBias: "neutral",
      btcScore: 0,
      shouldSuppress: false,
      suppressionFactor: 1.0,
      reason,
    };
  }

  private getLastValidValue(arr: number[]): number {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!isNaN(arr[i]!)) return arr[i]!;
    }
    return NaN;
  }

  private async loadCache(): Promise<CorrelationCache> {
    const data = await readFile(this.cacheFile, 'utf-8');
    return JSON.parse(data) as CorrelationCache;
  }

  private async saveCache(btcStructure: BtcStructure): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const cache: CorrelationCache = {
      timestamp: Date.now(),
      btcStructure,
    };
    await writeFile(this.cacheFile, JSON.stringify(cache, null, 2), 'utf-8');
  }
}