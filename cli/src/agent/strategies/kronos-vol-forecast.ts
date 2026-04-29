/**
 * Kronos Volatility Forecast Strategy — uses ML-predicted future volatility
 * to generate signals and inform risk management.
 *
 * How it works:
 * 1. Kronos generates N Monte Carlo price paths from historical OHLCV
 * 2. Path spread = predicted volatility (wider spread = more uncertain future)
 * 3. Directional bias = mean path direction (if most paths go up → bullish)
 *
 * Signal logic:
 * - directionalBias > 0.3: bullish signal (+0.2 to +0.4 scaled)
 * - directionalBias < -0.3: bearish signal (-0.2 to -0.4 scaled)
 * - High predicted vol (pathSpread > 8%): increase confidence on directional
 *   signals (high vol = big moves, worth trading), but clamp signal magnitude
 *   (don't overbet on volatile predictions)
 * - Low predicted vol (pathSpread < 3%): reduce confidence (narrow paths =
 *   range-bound, less opportunity)
 *
 * The volatility forecast is ALSO consumed by the executor (via StrategyContext)
 * for dynamic stop-loss width, separate from this signal.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class KronosVolForecastStrategy implements Strategy {
  name = 'kronosVolForecast';
  description = 'Kronos ML volatility forecast (directional bias + vol regime)';
  requiredData = ['kronosData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const k = ctx.kronosData;
    if (!k) {
      return {
        name: this.name,
        value: 0,
        confidence: 0,
        source: this.description,
        details: 'No Kronos forecast available',
      };
    }

    let value = 0;
    const details: string[] = [];
    let confidence = 0.3;

    // Directional bias from mean predicted path
    const bias = k.directionalBias;
    if (Math.abs(bias) > 0.3) {
      // Strong directional signal: scale from 0 at 0.3 to ±0.4 at ±1.0
      const strength = (Math.abs(bias) - 0.3) / 0.7; // 0 to 1
      value = Math.sign(bias) * (0.2 + strength * 0.2); // ±0.2 to ±0.4
      const dir = bias > 0 ? 'bullish' : 'bearish';
      details.push(`Kronos ${dir} bias ${(bias * 100).toFixed(0)}% → ${value >= 0 ? '+' : ''}${value.toFixed(2)}`);
      confidence = 0.4 + strength * 0.2; // 0.4 to 0.6
    } else if (Math.abs(bias) > 0.1) {
      // Mild directional lean — informational, weak signal
      value = bias * 0.15; // ±0.015 to ±0.045
      details.push(`Kronos mild ${bias > 0 ? 'bullish' : 'bearish'} lean ${(bias * 100).toFixed(0)}%`);
    } else {
      details.push(`Kronos neutral (bias ${(bias * 100).toFixed(0)}%)`);
    }

    // Vol regime context
    const spread = k.pathSpreadPct;
    if (spread > 8) {
      // High predicted vol: directional signals are MORE meaningful
      // (big moves expected — worth taking positions)
      if (Math.abs(value) > 0.05) {
        confidence = Math.min(confidence + 0.15, 0.75);
      }
      details.push(`High vol forecast (${spread.toFixed(1)}% path spread)`);
    } else if (spread < 3) {
      // Low predicted vol: range-bound expected, reduce conviction
      confidence *= 0.6;
      details.push(`Low vol forecast (${spread.toFixed(1)}% path spread)`);
    } else {
      details.push(`Normal vol (${spread.toFixed(1)}% path spread)`);
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.min(confidence, 1.0),
      source: this.description,
      details: details.join('; '),
    };
  }
}
