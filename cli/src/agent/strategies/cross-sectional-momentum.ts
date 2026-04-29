/**
 * Cross-Sectional Momentum Strategy
 *
 * Based on Kakushadze & Serur "151 Trading Strategies" §10.3, adapted for
 * crypto perpetuals. Ranks tokens by their 7-day return RELATIVE to the
 * group mean, expressed as a z-score. In flat markets where absolute signals
 * are muted, the token outperforming (or underperforming) the group still
 * produces a directional signal.
 *
 * Uses momentum (not contrarian) weighting — crypto trends persist:
 *   z_i = (R_i - R_m) / σ_R
 *   signal = clamp(z_i * 0.3, -1, 1)
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

/** Minimum number of tokens in the group to produce a meaningful z-score. */
const MIN_GROUP_SIZE = 3;

/** Scaling factor: z=1 → signal value 0.30. */
const Z_SCALE = 0.3;

/** Below this stdev the group is effectively flat — no meaningful dispersion. */
const MIN_STDEV = 1e-10;

export class CrossSectionalMomentumStrategy implements Strategy {
  name = 'crossSectionalMomentum';
  description = 'Ranks tokens by relative 7-day performance vs group (§10.3 Kakushadze)';
  requiredData = ['groupReturns'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const returns = ctx.groupReturns;
    if (!returns || Object.keys(returns).length < MIN_GROUP_SIZE) {
      return {
        name: this.name,
        value: 0,
        confidence: 0.1,
        source: 'Cross-Sectional',
        details: 'Insufficient group data',
      };
    }

    const myReturn = returns[ctx.tokenId];
    if (myReturn === undefined) {
      return {
        name: this.name,
        value: 0,
        confidence: 0.1,
        source: 'Cross-Sectional',
        details: 'Token not in group',
      };
    }

    const vals = Object.values(returns);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    const stdev = Math.sqrt(variance);

    if (stdev < MIN_STDEV) {
      return {
        name: this.name,
        value: 0,
        confidence: 0.1,
        source: 'Cross-Sectional',
        details: 'Zero group dispersion',
      };
    }

    const zScore = (myReturn - mean) / stdev;
    const value = clamp(zScore * Z_SCALE);
    const confidence = clamp(0.3 + Math.abs(zScore) * 0.2, 0.1, 0.9);

    return {
      name: this.name,
      value,
      confidence,
      source: 'Cross-Sectional Momentum',
      details: `7d return ${(myReturn * 100).toFixed(1)}% vs group mean ${(mean * 100).toFixed(1)}% (z=${zScore.toFixed(2)})`,
    };
  }
}
