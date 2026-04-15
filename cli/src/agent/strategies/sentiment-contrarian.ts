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

    // Only fire on EXTREMES — moderate fear/greed (20–35, 65–80) used to add a
    // persistent +0.2 to +0.5 contrarian bias during prolonged sentiment
    // regimes. Audit data showed sentimentContrarian held a constant +0.68
    // mean across 458 observations, dominating the sentiment category and
    // pushing every score upward regardless of price action. Restricting
    // contributions to extremes preserves the high-conviction edge while
    // killing the structural bias.
    if (fg < 20) {
      // Extreme fear: strong buy. Linear: fg=0 → +1.0, fg=20 → +0.6
      value = 1.0 - (fg / 20) * 0.4;
      confidence = 0.9;
      details.push(`Extreme fear (F&G=${fg}): strong contrarian buy signal`);
    } else if (fg > 80) {
      // Extreme greed: strong sell. Linear: fg=80 → -0.6, fg=100 → -1.0
      value = -(0.6 + ((fg - 80) / 20) * 0.4);
      confidence = 0.9;
      details.push(`Extreme greed (F&G=${fg}): strong contrarian sell signal`);
    } else {
      // Moderate / neutral zone: no contrarian edge — emit a near-zero
      // confidence signal so the scoring layer effectively ignores it.
      value = 0.0;
      confidence = 0.1;
      const label = fg < 35 ? 'mild fear' : fg > 65 ? 'mild greed' : 'neutral';
      details.push(`${label} (F&G=${fg}): below extremes, no edge`);
    }

    // Z-score adjustment: extreme social sentiment reinforces the signal
    if (ctx.sentimentZScore !== undefined) {
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
