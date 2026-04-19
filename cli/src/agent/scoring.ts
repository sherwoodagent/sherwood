/**
 * Signal scoring engine — converts raw data into trade decisions.
 */

import type { TechnicalSignals } from "./technical.js";
import { clamp } from "./utils.js";
import type { CorrelationCheck } from "./correlation.js";
import type { MarketRegime } from "./regime.js";
import { LiveCalibrator, type CalibrationFactor, type UncertaintyMetrics } from './calibration-live.js';

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

// Replay calibration over 5 days × 15 tokens / 1817 production observations
// ranked the `contrarian` profile (sentiment 0.40) #1 with Sharpe 1.354,
// while the prior `default` (sentiment 0.20) ranked 21st with Sharpe 0.296.
// Rebalanced to lift sentiment, cut the most-lagging signals (technical),
// and reduce smartMoney since x402 Nansen is often unfunded in practice.
// `onchain` slightly boosted — HL flow + fundingRate are the highest-firing
// live categories. Sums to 1.00.
export const DEFAULT_WEIGHTS: ScoringWeights = {
  smartMoney: 0.15,
  technical: 0.10,
  sentiment: 0.40,
  onchain: 0.20,
  fundamental: 0.10,
  event: 0.05,
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
  // Majors (BTC/ETH/SOL): no TVL/event data. 4 active categories.
  // Same rebalance rationale as DEFAULT_WEIGHTS — replay calibration showed
  // sentiment-heavy profiles dominating production-stack data; this profile
  // concentrates the freed-up weight into sentiment + onchain (the two
  // categories that produce directional opinions on majors). Technical and
  // smartMoney shrink because both are lagging or unfunded in practice.
  majors:    { smartMoney: 0.15, technical: 0.10, sentiment: 0.40, onchain: 0.35, fundamental: 0.00, event: 0.00 },
  // Altcoins: keep fundamental (TVL data exists) and event. Sentiment lifted
  // here too but less aggressively — altcoins respond more to TVL/flow than
  // majors, and the sentimentContrarian extremes-only fix means sentiment
  // weight is dormant most of the time.
  altcoin:   { smartMoney: 0.15, technical: 0.15, sentiment: 0.30, onchain: 0.20, fundamental: 0.10, event: 0.10 },
  // sentHeavy/techHeavy removed — unvalidated, added parameter complexity without evidence of benefit
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

export interface CalibratedTradeDecision extends TradeDecision {
  /** Original score before calibration applied */
  originalScore: number;
  /** Original confidence before calibration applied */
  originalConfidence: number;
  /** Calibration factor applied to score and confidence */
  calibrationFactor: CalibrationFactor;
  /** Uncertainty metrics affecting position sizing */
  uncertaintyMetrics: UncertaintyMetrics;
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
  // Paper-trading showed 0.25 let marginal entries through (BLUR 0.25, SUI 0.255).
  // 0.30 filters noise while keeping genuine signals (AAVE 0.33, ETH 0.30, ETHENA 0.39).
  //
  // SELL side is NOT symmetric with BUY: the contrarian sentiment model + on-chain
  // defaults + BTC-bullish suppression bias the aggregate score positive. Empirical
  // distribution over 2017 production signals: min -0.18, p3 ≈ -0.10, p50 ≈ +0.15.
  // With sell = -0.30, ZERO shorts fired in 8 days. -0.15 / -0.30 mirrors the BUY
  // spacing (0.30 / 0.55) against the negative tail we actually observe.
  "ranging":        { strongBuy: 0.55, buy: 0.30, sell: -0.15, strongSell: -0.30 },
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

/** Lagging technical indicators whose weight is dampened during momentum moves. */
const LAGGING_TECHNICAL_SIGNALS = new Set(['technical', 'meanReversion']);

/** Signal name → weight category mapping. */
const SIGNAL_CATEGORY_MAP: Record<string, keyof ScoringWeights> = {
  technical: "technical",
  sentiment: "sentiment",
  onchain: "onchain",
  fundamental: "fundamental",
  event: "event",
  smartMoney: "smartMoney",
  flowIntelligence: "smartMoney",  // shares smartMoney category — auto weight-split with perp signal

  // Strategy signal mappings to categories
  // momentum intentionally has no key in getStrategyAdjustments() — it keeps
  // full weight during momentum overrides (not dampened like lagging indicators).
  momentum: "technical",
  breakoutOnChain: "technical",
  meanReversion: "technical",
  multiTimeframe: "technical",
  dexFlow: "onchain",
  fundingRate: "onchain",          // FIX 2: was "fundamental" — wasted on majors (0.00 weight)
  tvlMomentum: "fundamental",
  sentimentContrarian: "sentiment",
  twitterSentiment: "sentiment",
  tokenUnlock: "event",
  hyperliquidFlow: "onchain",
};

/** Categories that rely on x402 paid data (Nansen, Messari). */
const X402_CATEGORIES: Set<keyof ScoringWeights> = new Set(["smartMoney", "event"]);

export function computeTradeDecision(
  signals: Signal[],
  weights?: ScoringWeights,
  regimeAdjustments?: Record<string, number>,
  correlationCheck?: CorrelationCheck,
  regime?: MarketRegime,
  x402Available?: boolean,
): TradeDecision {
  const w = weights ?? DEFAULT_WEIGHTS;
  const thresholds = thresholdsForRegime(regime);

  // FIX 1: When x402 was configured but wallet is unfunded, exclude
  // x402-dependent categories (smartMoney, event) so their zero-value signals
  // don't dilute the aggregate. Only when x402Available is explicitly false
  // (meaning x402 was intended but failed) — undefined means x402 was never
  // configured, so no exclusion (the agent may have those signals from other
  // sources, e.g. backtest or manual injection).
  const excludedCategories = new Set<keyof ScoringWeights>();
  if (x402Available === false) {
    for (const cat of X402_CATEGORIES) {
      if (w[cat] > 0) excludedCategories.add(cat);
    }
  }

  // FIX 3: Normalize per-category weights.
  // Count how many signals fire per category, then split category weight among them.
  const categoryCounts: Record<string, number> = {};
  for (const signal of signals) {
    if (signal._weightOverride !== undefined) continue; // manual overrides skip normalization
    const category = SIGNAL_CATEGORY_MAP[signal.name];
    if (!category || excludedCategories.has(category)) continue;
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
  }

  // Weighted sum
  let totalWeight = 0;
  let weightedSum = 0;
  let weightedConfidence = 0;

  for (const signal of signals) {
    // Determine signal weight
    let signalWeight: number;

    if (signal._weightOverride !== undefined) {
      signalWeight = signal._weightOverride;
    } else {
      const category = SIGNAL_CATEGORY_MAP[signal.name];

      // FIX 1: skip signals in excluded x402 categories
      if (category && excludedCategories.has(category)) continue;

      const categoryWeight = category ? w[category] : 0.1;
      const count = category ? (categoryCounts[category] ?? 1) : 1;
      // FIX 3: split category weight among all signals in that category
      signalWeight = categoryWeight / count;
    }

    // Apply regime adjustment if available
    let adjustedValue = signal.value;
    let adjustedConfidence = signal.confidence;

    if (regimeAdjustments && signal.name in regimeAdjustments) {
      const adjustment = regimeAdjustments[signal.name]!;
      adjustedValue *= adjustment;
      adjustedConfidence *= adjustment;
    }

    // Dampen lagging technical indicators during momentum moves.
    // RSI/MACD/EMA read bearish alignment during the first hours of a pump
    // because they lag by construction (14-period RSI, 26-period MACD, 50/200 EMA).
    // This cancels real-time bullish signals — ETH scored 0.00 during a +7.8% rally
    // because scoreTechnical() was reading stale bearish MACD/EMA.
    //
    // When the regime is a momentum override (trending-up/down), cut the weight
    // of lagging technical signals by 50%. The momentum signal (which is NOT lagged)
    // and breakoutOnChain (which uses recent price action) keep their full weight.
    // LAGGING_TECHNICAL_SIGNALS hoisted to module level for GC efficiency
    if (regime && (regime === 'trending-up' || regime === 'trending-down')
        && LAGGING_TECHNICAL_SIGNALS.has(signal.name)) {
      signalWeight *= 0.5;
    }

    weightedSum += adjustedValue * signalWeight;
    weightedConfidence += adjustedConfidence * signalWeight;
    totalWeight += signalWeight;
  }

  let score = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const confidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

  // ── Convergence bonus ──
  // When multiple independent categories agree on direction, amplify the score.
  // The weighted average treats disagreement and agreement symmetrically — a
  // 5/6 bullish consensus scores the same as if those 5 categories had smaller
  // values. In reality, broad agreement across uncorrelated sources (technical +
  // sentiment + on-chain + funding) is stronger evidence than any single source
  // at high conviction.
  //
  // On the Apr 13-14 BTC pump: 4-5 categories were bullish but the score
  // capped at 0.27. With convergence bonus: 0.27 × 1.15 = 0.31 → fires BUY.
  if (Math.abs(score) > 0.01) {
    const scoreSign = Math.sign(score);
    // Compute net direction per active category.
    // NOTE: uses raw signal.value (not dampened). This means a dampened
    // technical signal at -0.30 still votes "bearish" in convergence even
    // though its weighted contribution is halved. This is intentional:
    // dampening reduces a lagging signal's INFLUENCE on the score, but
    // its DIRECTIONAL OPINION still counts for convergence. If we used
    // dampened values, a 50% weight cut would make a -0.30 signal appear
    // as -0.15, potentially flipping the category to "neutral" and
    // artificially inflating the convergence count.
    const categoryNetDirection = new Map<string, number>();
    for (const signal of signals) {
      const category = SIGNAL_CATEGORY_MAP[signal.name];
      if (!category || excludedCategories.has(category)) continue;
      if (signal._weightOverride !== undefined) continue;
      const current = categoryNetDirection.get(category) ?? 0;
      categoryNetDirection.set(category, current + signal.value);
    }
    // Count categories that agree with the aggregate direction
    let agreeing = 0;
    let totalActive = 0;
    for (const [, netValue] of categoryNetDirection) {
      totalActive++;
      if (Math.sign(netValue) === scoreSign) agreeing++;
    }
    // Bonus kicks in at 4+ agreeing categories out of at least 4 active.
    // Scale: 4/N → 1.15x, 5/N → 1.30x, 6/N → 1.45x. Capped at 1.45x.
    if (agreeing >= 4 && totalActive >= 4) {
      const bonus = 1.0 + 0.15 * (agreeing - 3);
      score *= Math.min(bonus, 1.45);
    }
  }

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

    score = Math.max(-1, Math.min(1, score));
  }

  // Unconditional clamp — convergence bonus and correlation boost can both
  // push score beyond [-1, 1]. Clamp was previously only inside the
  // correlationCheck block; scores flowed unclamped when no correlation
  // data was available.
  score = Math.max(-1, Math.min(1, score));

  // Determine action using regime-conditional thresholds
  let action: TradeDecision["action"];
  // Symmetric >= / <= on both sides — exactly hitting a threshold counts as
  // crossing it. Score == buy → BUY. Score == sell → SELL. Score ==
  // strongSell → STRONG_SELL. This replaces the old mixed > / >= scheme
  // flagged in code review as asymmetric.
  if (score >= thresholds.strongBuy) action = "STRONG_BUY";
  else if (score >= thresholds.buy) action = "BUY";
  else if (score <= thresholds.strongSell) action = "STRONG_SELL";
  else if (score <= thresholds.sell) action = "SELL";
  else action = "HOLD";

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

/**
 * Enhanced computeTradeDecision with regime-aware calibration and uncertainty sizing.
 * Applies calibration factors based on historical performance and calculates uncertainty metrics.
 */
export function computeCalibratedTradeDecision(
  tokenId: string,
  signals: Signal[],
  recentPrices: number[],
  weights?: ScoringWeights,
  regimeAdjustments?: Record<string, number>,
  correlationCheck?: CorrelationCheck,
  regime?: MarketRegime,
  x402Available?: boolean,
  calibrator?: LiveCalibrator,
): CalibratedTradeDecision {
  // Get base decision using existing logic
  const baseDecision = computeTradeDecision(
    signals,
    weights,
    regimeAdjustments,
    correlationCheck,
    regime,
    x402Available
  );

  // Store original values
  const originalScore = baseDecision.score;
  const originalConfidence = baseDecision.confidence;

  // Initialize calibrator if not provided
  const liveCalibrator = calibrator ?? new LiveCalibrator();

  // Get calibration factor based on regime and action
  const actionFamily = baseDecision.action.includes('BUY') ? 'BUY' :
                      baseDecision.action.includes('SELL') ? 'SELL' : 'HOLD';

  const calibrationFactor = liveCalibrator.getCalibrationFactor(
    tokenId,
    regime ?? 'unknown',
    actionFamily
  );

  // Calculate uncertainty metrics
  const uncertaintyMetrics = liveCalibrator.calculateUncertainty(
    signals,
    recentPrices,
    tokenId
  );

  // Apply calibration factor to score and confidence
  let calibratedScore = originalScore * calibrationFactor.factor;
  let calibratedConfidence = originalConfidence * calibrationFactor.factor;

  // Clamp values to valid ranges
  calibratedScore = Math.max(-1, Math.min(1, calibratedScore));
  calibratedConfidence = Math.max(0, Math.min(1, calibratedConfidence));

  // Re-determine action with calibrated score
  const thresholds = baseDecision.thresholds!;
  let action: TradeDecision["action"];
  if (calibratedScore >= thresholds.strongBuy) action = "STRONG_BUY";
  else if (calibratedScore >= thresholds.buy) action = "BUY";
  else if (calibratedScore <= thresholds.strongSell) action = "STRONG_SELL";
  else if (calibratedScore <= thresholds.sell) action = "SELL";
  else action = "HOLD";

  // Build enhanced reasoning
  const calibrationNote = calibrationFactor.factor !== 1.0 ?
    `\n[Calibration] Applied ${calibrationFactor.factor.toFixed(2)}x factor: ${calibrationFactor.reason}` : '';
  const uncertaintyNote = uncertaintyMetrics.sizeMultiplier !== 1.0 ?
    `\n[Uncertainty] ${uncertaintyMetrics.level} uncertainty → ${uncertaintyMetrics.sizeMultiplier}x position size` : '';

  return {
    action,
    score: calibratedScore,
    signals: baseDecision.signals,
    reasoning: baseDecision.reasoning + calibrationNote + uncertaintyNote,
    confidence: calibratedConfidence,
    timestamp: baseDecision.timestamp,
    thresholds: baseDecision.thresholds,
    originalScore,
    originalConfidence,
    calibrationFactor,
    uncertaintyMetrics,
  };
}
