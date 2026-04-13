/**
 * Signal scoring engine — converts raw data into trade decisions.
 */

import type { TechnicalSignals } from "./technical.js";
import { clamp } from "./utils.js";
import type { CorrelationCheck } from "./correlation.js";
import type { MarketRegime } from "./regime.js";

export interface Signal {
  name: string;
  value: number;       // -1.0 to +1.0
  confidence: number;  // 0.0 to 1.0
  source: string;
  details: string;
  _weightOverride?: number;
}

export interface ScoringWeights {
  smartMoney: number;
  technical: number;
  sentiment: number;
  onchain: number;
  fundamental: number;
  event: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  smartMoney: 0.25,
  technical: 0.20,
  sentiment: 0.20,
  onchain: 0.15,
  fundamental: 0.10,
  event: 0.10,
};

/**
 * Named weight profiles for `--weight-profile <name>` and per-asset auto-selection.
 *
 * - default:    balanced — used when no profile selected
 * - majors:     BTC/ETH/SOL — drops fundamental (no meaningful TVL on BTC),
 *               drops event (token unlocks rare on majors). Mass redistributed
 *               to technical + sentiment + smartMoney + onchain (the 4 that
 *               actually fire on majors per signal-audit data).
 * - altcoin:    smaller caps — keeps fundamental + event because TVL deltas
 *               and unlocks meaningfully drive price action on altcoins.
 * - sentHeavy:  contrarian setups (extreme F&G), bias toward sentiment signal.
 * - techHeavy:  trend continuation setups, bias toward technical confirmation.
 */
export const WEIGHT_PROFILES: Record<string, ScoringWeights> = {
  default: DEFAULT_WEIGHTS,
  majors:    { smartMoney: 0.30, technical: 0.30, sentiment: 0.20, onchain: 0.20, fundamental: 0.00, event: 0.00 },
  altcoin:   { smartMoney: 0.20, technical: 0.15, sentiment: 0.15, onchain: 0.15, fundamental: 0.20, event: 0.15 },
  sentHeavy: { smartMoney: 0.10, technical: 0.15, sentiment: 0.40, onchain: 0.15, fundamental: 0.10, event: 0.10 },
  techHeavy: { smartMoney: 0.10, technical: 0.40, sentiment: 0.15, onchain: 0.15, fundamental: 0.10, event: 0.10 },
};

/** Tokens that get the "majors" profile when auto-selection is enabled. */
const MAJORS_TOKEN_IDS = new Set(["bitcoin", "ethereum", "solana"]);

/**
 * Pick a weight profile for a token. Returns user-specified profile if given,
 * otherwise auto-selects "majors" for BTC/ETH/SOL and "default" for everything else.
 */
export function profileForToken(tokenId: string, userProfile?: string): ScoringWeights {
  if (userProfile && WEIGHT_PROFILES[userProfile]) {
    return WEIGHT_PROFILES[userProfile];
  }
  if (MAJORS_TOKEN_IDS.has(tokenId.toLowerCase())) {
    return WEIGHT_PROFILES["majors"]!;
  }
  return DEFAULT_WEIGHTS;
}

export interface TradeDecision {
  action: "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL";
  score: number;
  signals: Signal[];
  reasoning: string;
  confidence: number;
  timestamp: number;
  /** Thresholds actually used to decide action — for audit + backtest replay. */
  thresholds?: ActionThresholds;
}

/** BUY/SELL action thresholds. All values are score cutoffs in [-1, 1]. */
export interface ActionThresholds {
  strongBuy: number;  // score >= strongBuy → STRONG_BUY
  buy: number;        // score >= buy → BUY
  sell: number;       // score <= sell → SELL (negative)
  strongSell: number; // score <= strongSell → STRONG_SELL (more negative)
}

/** Default thresholds — symmetric, used when no regime info is provided. */
export const DEFAULT_THRESHOLDS: ActionThresholds = {
  strongBuy: 0.6,
  buy: 0.3,
  sell: -0.3,
  strongSell: -0.6,
};

/**
 * Regime-conditional thresholds.
 *
 * Trending regimes: asymmetric — easier to enter WITH the trend, harder to fade it.
 * Ranging: symmetric but tighter — whipsaws are expensive, demand more conviction.
 * High-volatility: tighter — wide moves without direction mean more false signals.
 * Low-volatility: looser — cleaner signal environment, less noise to filter.
 */
export const REGIME_THRESHOLDS: Record<MarketRegime, ActionThresholds> = {
  "trending-up": { strongBuy: 0.55, buy: 0.25, sell: -0.40, strongSell: -0.70 },
  "trending-down": { strongBuy: 0.70, buy: 0.40, sell: -0.25, strongSell: -0.55 },
  "ranging":        { strongBuy: 0.65, buy: 0.40, sell: -0.40, strongSell: -0.65 },
  "high-volatility":{ strongBuy: 0.70, buy: 0.45, sell: -0.45, strongSell: -0.70 },
  "low-volatility": { strongBuy: 0.60, buy: 0.30, sell: -0.30, strongSell: -0.60 },
};

export function thresholdsForRegime(regime?: MarketRegime): ActionThresholds {
  if (!regime) return DEFAULT_THRESHOLDS;
  return REGIME_THRESHOLDS[regime] ?? DEFAULT_THRESHOLDS;
}

// ── Score Technical Signals ──

export function scoreTechnical(signals: TechnicalSignals): Signal {
  let value = 0;
  const details: string[] = [];
  let confidence = 0.5;

  // If most indicators are NaN, reduce confidence significantly
  const nanCount = [signals.rsi, signals.macd.histogram, signals.bb.width, signals.ema.ema50].filter(v => isNaN(v)).length;
  if (nanCount >= 3) {
    confidence = 0.15;
    details.push("Insufficient data for most indicators");
  }

  // RSI scoring
  const rsi = signals.rsi;
  if (!isNaN(rsi)) {
    if (rsi < 30) {
      const rsiScore = 0.5 + 0.3 * ((30 - rsi) / 30); // 0.5 at RSI=30, 0.8 at RSI=0
      value += rsiScore;
      details.push(`RSI ${rsi.toFixed(1)} oversold (+${rsiScore.toFixed(2)})`);
      confidence += 0.1;
    } else if (rsi > 70) {
      const rsiScore = -(0.5 + 0.3 * ((rsi - 70) / 30)); // -0.5 at RSI=70, -0.8 at RSI=100
      value += rsiScore;
      details.push(`RSI ${rsi.toFixed(1)} overbought (${rsiScore.toFixed(2)})`);
      confidence += 0.1;
    } else {
      // Scale linearly: RSI 50 → 0, RSI 30 → +0.5, RSI 70 → -0.5
      const rsiScore = -((rsi - 50) / 20) * 0.5;
      value += rsiScore;
      details.push(`RSI ${rsi.toFixed(1)} (${rsiScore >= 0 ? "+" : ""}${rsiScore.toFixed(2)})`);
    }
  }

  // MACD histogram scoring
  const hist = signals.macd.histogram;
  if (!isNaN(hist)) {
    if (hist > 0) {
      value += 0.3;
      details.push(`MACD histogram positive (+0.30)`);
    } else if (hist < 0) {
      value -= 0.3;
      details.push(`MACD histogram negative (-0.30)`);
    }
  }

  // Bollinger Bands scoring
  if (signals.bb.squeeze) {
    // Squeeze = neutral, wait for breakout
    details.push("BB squeeze detected (neutral, awaiting breakout)");
  } else {
    const lastClose = signals.ema.ema8; // Use ema8 as proxy for current price
    if (!isNaN(signals.bb.lower) && !isNaN(lastClose)) {
      const volSpike = signals.volume.ratio > 1.5;
      if (lastClose < signals.bb.lower && volSpike) {
        value += 0.5;
        details.push("Price below lower BB with volume spike (+0.50)");
        confidence += 0.1;
      } else if (lastClose > signals.bb.upper && volSpike) {
        value -= 0.5;
        details.push("Price above upper BB with volume spike (-0.50)");
        confidence += 0.1;
      }
    }
  }

  // EMA alignment scoring
  const { ema8, ema21, ema50, ema200 } = signals.ema;
  if (!isNaN(ema8) && !isNaN(ema21) && !isNaN(ema50) && !isNaN(ema200)) {
    if (ema8 > ema21 && ema21 > ema50 && ema50 > ema200) {
      value += 0.4;
      details.push("Bullish EMA alignment (8>21>50>200) (+0.40)");
      confidence += 0.1;
    } else if (ema8 < ema21 && ema21 < ema50 && ema50 < ema200) {
      value -= 0.4;
      details.push("Bearish EMA alignment (8<21<50<200) (-0.40)");
      confidence += 0.1;
    }
  }

  return {
    name: "technical",
    value: clamp(value),
    confidence: Math.min(confidence, 1.0),
    source: "Technical Analysis",
    details: details.join("; "),
  };
}

// ── Score Sentiment ──

export function scoreSentiment(fearAndGreed: number, sentimentZScore?: number): Signal {
  let value = 0;
  const details: string[] = [];
  let confidence = 0.6;

  if (fearAndGreed < 15) {
    value = 1.0;
    details.push(`Extreme fear (F&G=${fearAndGreed}) → max contrarian buy`);
    confidence = 0.8;
  } else if (fearAndGreed < 25) {
    // Linear interpolation: F&G 15→+0.8, F&G 25→+0.5
    value = 0.8 - 0.3 * ((fearAndGreed - 15) / 10);
    details.push(`Fear (F&G=${fearAndGreed}) → contrarian buy (+${value.toFixed(2)})`);
    confidence = 0.7;
  } else if (fearAndGreed < 40) {
    // F&G 25→+0.3, F&G 40→+0.1
    value = 0.3 - 0.2 * ((fearAndGreed - 25) / 15);
    details.push(`Mild fear (F&G=${fearAndGreed}) → slight buy (+${value.toFixed(2)})`);
  } else if (fearAndGreed <= 60) {
    value = 0;
    details.push(`Neutral sentiment (F&G=${fearAndGreed})`);
    confidence = 0.4;
  } else if (fearAndGreed <= 75) {
    // F&G 60→-0.1, F&G 75→-0.5
    value = -0.1 - 0.4 * ((fearAndGreed - 60) / 15);
    details.push(`Greed (F&G=${fearAndGreed}) → contrarian sell (${value.toFixed(2)})`);
  } else {
    // F&G 75→-0.5, F&G 100→-1.0
    value = -0.5 - 0.5 * ((fearAndGreed - 75) / 25);
    details.push(`Extreme greed (F&G=${fearAndGreed}) → max contrarian sell (${value.toFixed(2)})`);
    confidence = 0.8;
  }

  // Z-score adjustment
  if (sentimentZScore !== undefined) {
    const adjustment = clamp(sentimentZScore * 0.1, -0.2, 0.2);
    value = clamp(value + adjustment);
    if (Math.abs(adjustment) > 0.05) {
      details.push(`Z-score adjustment: ${adjustment >= 0 ? "+" : ""}${adjustment.toFixed(2)}`);
    }
  }

  return {
    name: "sentiment",
    value: clamp(value),
    confidence,
    source: "Market Sentiment",
    details: details.join("; "),
  };
}

// ── Score On-Chain ──

export function scoreOnChain(data: {
  exchangeNetFlow?: number;
  whaleAccumulating?: boolean;
  activeAddressesGrowth?: number;
}): Signal {
  let value = 0;
  const details: string[] = [];
  let confidence = 0.4;

  if (data.exchangeNetFlow !== undefined) {
    if (data.exchangeNetFlow < 0) {
      // Negative net flow = tokens leaving exchanges = bullish
      value += 0.4;
      details.push("Negative exchange net flow (bullish)");
      confidence += 0.1;
    } else if (data.exchangeNetFlow > 0) {
      value -= 0.4;
      details.push("Positive exchange net flow (bearish)");
      confidence += 0.1;
    }
  }

  if (data.whaleAccumulating !== undefined) {
    if (data.whaleAccumulating) {
      value += 0.3;
      details.push("Whale accumulation detected");
      confidence += 0.15;
    } else {
      value -= 0.3;
      details.push("Whale distribution detected");
      confidence += 0.15;
    }
  }

  if (data.activeAddressesGrowth !== undefined) {
    const growth = data.activeAddressesGrowth;
    if (growth > 0.1) {
      value += 0.2;
      details.push(`Active addresses growing (${(growth * 100).toFixed(1)}%)`);
    } else if (growth < -0.1) {
      value -= 0.2;
      details.push(`Active addresses declining (${(growth * 100).toFixed(1)}%)`);
    }
  }

  if (details.length === 0) {
    details.push("No on-chain data available");
    confidence = 0.1;
  }

  return {
    name: "onchain",
    value: clamp(value),
    confidence: Math.min(confidence, 1.0),
    source: "On-Chain Analysis",
    details: details.join("; "),
  };
}

// ── Score Fundamentals ──

export function scoreFundamental(data: {
  tvlGrowthWeekly?: number;
  revenueGrowth?: number;
  mcapToTvl?: number;
}): Signal {
  let value = 0;
  const details: string[] = [];
  let confidence = 0.4;

  if (data.tvlGrowthWeekly !== undefined) {
    const g = data.tvlGrowthWeekly;
    if (g > 0.1) {
      value += 0.4;
      details.push(`TVL growing ${(g * 100).toFixed(1)}% weekly`);
      confidence += 0.1;
    } else if (g < -0.1) {
      value -= 0.4;
      details.push(`TVL declining ${(g * 100).toFixed(1)}% weekly`);
      confidence += 0.1;
    }
  }

  if (data.revenueGrowth !== undefined) {
    const g = data.revenueGrowth;
    if (g > 0.1) {
      value += 0.3;
      details.push(`Revenue growing ${(g * 100).toFixed(1)}%`);
    } else if (g < -0.1) {
      value -= 0.3;
      details.push(`Revenue declining ${(g * 100).toFixed(1)}%`);
    }
  }

  if (data.mcapToTvl !== undefined) {
    const ratio = data.mcapToTvl;
    if (ratio < 1.0) {
      value += 0.3;
      details.push(`Mcap/TVL ratio ${ratio.toFixed(2)} (undervalued)`);
      confidence += 0.1;
    } else if (ratio > 5.0) {
      value -= 0.3;
      details.push(`Mcap/TVL ratio ${ratio.toFixed(2)} (overvalued)`);
      confidence += 0.1;
    }
  }

  if (details.length === 0) {
    details.push("No fundamental data available");
    confidence = 0.1;
  }

  return {
    name: "fundamental",
    value: clamp(value),
    confidence: Math.min(confidence, 1.0),
    source: "Fundamental Analysis",
    details: details.join("; "),
  };
}

// ── Score Events ──

export function scoreEvent(data: {
  unlockPercent?: number;
  daysUntilUnlock?: number;
  positiveEvent?: boolean;
}): Signal {
  let value = 0;
  const details: string[] = [];
  let confidence = 0.3;

  if (data.unlockPercent !== undefined && data.daysUntilUnlock !== undefined) {
    if (data.unlockPercent > 5 && data.daysUntilUnlock < 30) {
      // Large upcoming unlock = bearish
      const severity = Math.min(data.unlockPercent / 20, 1.0);
      value -= severity * 0.8;
      details.push(
        `Token unlock: ${data.unlockPercent.toFixed(1)}% in ${data.daysUntilUnlock} days (bearish)`,
      );
      confidence = 0.7;
    } else if (data.unlockPercent < 2) {
      details.push("Minor unlock, negligible impact");
    }
  }

  if (data.positiveEvent !== undefined) {
    if (data.positiveEvent) {
      value += 0.4;
      details.push("Positive catalyst event");
      confidence += 0.2;
    } else {
      value -= 0.4;
      details.push("Negative catalyst event");
      confidence += 0.2;
    }
  }

  if (details.length === 0) {
    details.push("No event data available");
    confidence = 0.1;
  }

  return {
    name: "event",
    value: clamp(value),
    confidence: Math.min(confidence, 1.0),
    source: "Event Analysis",
    details: details.join("; "),
  };
}

// ── Combine All Signals Into Trade Decision ──

export function computeTradeDecision(
  signals: Signal[],
  weights?: ScoringWeights,
  regimeAdjustments?: Record<string, number>,
  correlationCheck?: CorrelationCheck,
  regime?: MarketRegime,
): TradeDecision {
  const w = weights ?? DEFAULT_WEIGHTS;
  const thresholds = thresholdsForRegime(regime);

  // Map signal names to weight keys
  const weightMap: Record<string, number> = {
    technical: w.technical,
    sentiment: w.sentiment,
    onchain: w.onchain,
    fundamental: w.fundamental,
    event: w.event,
    smartMoney: w.smartMoney,

    // Strategy signal mappings to categories
    breakoutOnChain: w.technical,
    meanReversion: w.technical,
    multiTimeframe: w.technical,
    dexFlow: w.onchain,
    fundingRate: w.fundamental,
    tvlMomentum: w.fundamental,
    sentimentContrarian: w.sentiment,
    twitterSentiment: w.sentiment,
    tokenUnlock: w.event,
    hyperliquidFlow: w.onchain,
  };

  // Weighted sum
  let totalWeight = 0;
  let weightedSum = 0;
  let weightedConfidence = 0;

  for (const signal of signals) {
    const signalWeight = signal._weightOverride ?? weightMap[signal.name] ?? 0.1;

    // Apply regime adjustment if available
    let adjustedValue = signal.value;
    let adjustedConfidence = signal.confidence;

    if (regimeAdjustments && signal.name in regimeAdjustments) {
      const adjustment = regimeAdjustments[signal.name]!;
      adjustedValue *= adjustment;
      adjustedConfidence *= adjustment;
    }

    weightedSum += adjustedValue * signalWeight;
    weightedConfidence += adjustedConfidence * signalWeight;
    totalWeight += signalWeight;
  }

  let score = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const confidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

  // Apply correlation-aware adjustment if provided
  // BTC bearish → suppress longs, boost shorts
  // BTC bullish → boost longs, suppress shorts
  if (correlationCheck) {
    if (correlationCheck.btcBias === "bearish" && score > 0) {
      // Suppress long signals when BTC is bearish (factor < 1)
      score *= correlationCheck.suppressionFactor;
    } else if (correlationCheck.btcBias === "bearish" && score < 0) {
      // Boost short signals when BTC is bearish
      score *= (1 + Math.abs(correlationCheck.btcScore) * 0.3);
    } else if (correlationCheck.btcBias === "bullish" && score > 0) {
      // Boost long signals when BTC is bullish
      score *= (1 + Math.abs(correlationCheck.btcScore) * 0.3);
    } else if (correlationCheck.btcBias === "bullish" && score < 0) {
      // Suppress short signals when BTC is bullish (factor < 1)
      score *= correlationCheck.suppressionFactor;
    }

    // Clamp the final score
    score = Math.max(-1, Math.min(1, score));
  }

  // Determine action using regime-conditional thresholds
  let action: TradeDecision["action"];
  if (score >= thresholds.strongBuy) action = "STRONG_BUY";
  else if (score >= thresholds.buy) action = "BUY";
  else if (score > thresholds.sell) action = "HOLD";
  else if (score > thresholds.strongSell) action = "SELL";
  else action = "STRONG_SELL";

  const reasoning = signals.map((s) => `[${s.source}] ${s.details}`).join("\n");

  return {
    action,
    score,
    signals,
    reasoning,
    confidence,
    timestamp: Date.now(),
    thresholds,
  };
}
