/**
 * Contrarian Sentiment Strategy
 * Uses Fear & Greed index and social sentiment Z-score to trade against the crowd.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class SentimentContrarianStrategy implements Strategy {
  name = 'sentimentContrarian';
  description = 'Contrarian strategy: buys extreme fear, sells extreme greed, with social Z-score adjustment';
  requiredData = ['fearAndGreed'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    if (!ctx.fearAndGreed) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.1,
        source: 'Contrarian Sentiment',
        details: 'No Fear & Greed data available',
      };
    }

    const fg = ctx.fearAndGreed.value;
    const details: string[] = [];
    let value = 0;
    let confidence = 0.3;

    // Fire on F&G extremes — moderate zones add a persistent contrarian bias
    // that washes out price signal (audit showed +0.68 constant mean).
    // Threshold widened from <20 / >80 to <25 / >75 to match alternative.me's
    // own "Extreme Fear" / "Extreme Greed" classification cutoffs and to
    // avoid sitting silent during real-but-just-shy-of-extreme regimes (e.g.
    // F&G=23 should clearly fire bullish contrarian; the prior <20 cutoff
    // missed it).
    const FEAR_CUTOFF = 25;
    const GREED_CUTOFF = 75;
    let fired = false;
    if (fg < FEAR_CUTOFF) {
      // Extreme fear: strong buy. Linear: fg=0 → +1.0, fg=25 → +0.5
      value = 1.0 - (fg / FEAR_CUTOFF) * 0.5;
      confidence = 0.9;
      fired = true;
      details.push(`Extreme fear (F&G=${fg}): strong contrarian buy signal`);
    } else if (fg > GREED_CUTOFF) {
      // Extreme greed: strong sell. Linear: fg=75 → -0.5, fg=100 → -1.0
      value = -(0.5 + ((fg - GREED_CUTOFF) / (100 - GREED_CUTOFF)) * 0.5);
      confidence = 0.9;
      fired = true;
      details.push(`Extreme greed (F&G=${fg}): strong contrarian sell signal`);
    } else {
      // Moderate / neutral zone: no contrarian edge — emit a near-zero
      // confidence signal so the scoring layer effectively ignores it.
      value = 0.0;
      confidence = 0.1;
      const label = fg < 40 ? 'mild fear' : fg > 60 ? 'mild greed' : 'neutral';
      details.push(`${label} (F&G=${fg}): below extremes, no edge`);
    }

    // Z-score adjustment ONLY when the main F&G logic actually fired. In the
    // moderate zone we explicitly returned value=0 to disclaim signal — the
    // Z-score block was bypassing that and re-introducing ±0.1 noise, which
    // produced false directional pulls (e.g. value=-0.1 with confidence=0.1
    // showing up in production logs even when "no edge" was the verdict).
    if (fired && ctx.sentimentZScore !== undefined) {
      const z = ctx.sentimentZScore;
      // If Z-score agrees with F&G direction, strengthen; if contradicts, weaken
      let adjustment = 0;
      if (z < -1.5 && value > 0) {
        // Extreme negative social sentiment + fear = stronger buy
        adjustment = 0.2;
        details.push(`Social Z-score ${z.toFixed(2)} reinforces buy (+0.20)`);
      } else if (z > 1.5 && value < 0) {
        // Extreme positive social sentiment + greed = stronger sell
        adjustment = -0.2;
        details.push(`Social Z-score ${z.toFixed(2)} reinforces sell (-0.20)`);
      } else if (Math.abs(z) > 1.0) {
        // Moderate Z-score adjustment
        adjustment = z > 0 ? -0.1 : 0.1;
        if (Math.abs(adjustment) > 0.05) {
          details.push(`Social Z-score ${z.toFixed(2)} adjustment (${adjustment > 0 ? '+' : ''}${adjustment.toFixed(2)})`);
        }
      }
      value = clamp(value + adjustment);
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.min(confidence, 1.0),
      source: 'Contrarian Sentiment',
      details: details.join('; '),
    };
  }
}
