/**
 * Prediction Market Strategy
 *
 * Uses Polymarket/Manifold prediction market probabilities to derive
 * directional signals. High-conviction markets (>75% or <25%) for
 * bullish/bearish crypto events contribute to the score.
 */

import type { Signal } from "../scoring.js";
import type { Strategy, StrategyContext } from "./types.js";
import { clamp } from "../utils.js";

const BULLISH_KEYWORDS = ["approve", "etf", "cut", "ease", "adopt", "pass", "bull"];
const BEARISH_KEYWORDS = ["ban", "restrict", "crash", "reject", "hike", "bear", "default"];

function classifyQuestion(question: string): "bullish" | "bearish" | "neutral" {
  const q = question.toLowerCase();
  if (BULLISH_KEYWORDS.some((kw) => q.includes(kw))) return "bullish";
  if (BEARISH_KEYWORDS.some((kw) => q.includes(kw))) return "bearish";
  return "neutral";
}

export class PredictionMarketStrategy implements Strategy {
  name = "predictionMarket";
  description =
    "Derives directional signals from high-conviction prediction market probabilities";
  requiredData = ["predictionData"];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const predictionData = ctx.predictionData;

    if (!predictionData || !predictionData.markets || predictionData.markets.length === 0) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.0,
        source: "Prediction Markets",
        details: "No prediction market data available",
      };
    }

    let bullishScore = 0;
    let bearishScore = 0;
    const details: string[] = [];

    for (const market of predictionData.markets) {
      const classification = classifyQuestion(market.question);
      if (classification === "neutral") continue;

      const prob = market.probability;

      // Only process high-conviction markets
      if (prob > 0.75) {
        // Scale: 0 at 75%, 1 at 100%, then × 0.15 per market (max contribution)
        const strength = (prob - 0.75) * 4 * 0.15;
        if (classification === "bullish") {
          bullishScore += strength;
          details.push(`Bullish event likely (${(prob * 100).toFixed(0)}%): ${market.question}`);
        } else {
          bearishScore += strength;
          details.push(`Bearish event likely (${(prob * 100).toFixed(0)}%): ${market.question}`);
        }
      } else if (prob < 0.25) {
        // Event is unlikely — mild contrarian signal
        if (classification === "bullish") {
          bearishScore += 0.05;
          details.push(`Bullish event unlikely (${(prob * 100).toFixed(0)}%): ${market.question}`);
        } else {
          bullishScore += 0.05;
          details.push(`Bearish event unlikely (${(prob * 100).toFixed(0)}%): ${market.question}`);
        }
      }
    }

    const rawValue = bullishScore - bearishScore;
    const value = clamp(rawValue, -0.5, 0.5);

    return {
      name: this.name,
      value,
      confidence: details.length > 0 ? 0.5 : 0.1,
      source: "Prediction Markets",
      details: details.length > 0 ? details.join("; ") : "No high-conviction markets found",
    };
  }
}
