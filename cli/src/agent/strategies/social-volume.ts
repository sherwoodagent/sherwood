/**
 * Contrarian Social Volume Strategy
 * Trades against crowd attention — elevated news coverage is contrarian bearish.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class SocialVolumeStrategy implements Strategy {
  name = 'socialVolume';
  description = 'Contrarian social volume: fades extreme news attention, neutral when coverage is low';
  requiredData = ['socialData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    if (!ctx.socialData) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.1,
        source: 'Social Volume',
        details: 'No social data available',
      };
    }

    const { newsCount24h } = ctx.socialData;
    let value = 0;
    let confidence = 0.3;
    let detail: string;

    if (newsCount24h > 10) {
      // Extreme attention — contrarian bearish
      value = -0.2;
      confidence = 0.5;
      detail = `Extreme news attention (${newsCount24h} articles): contrarian bearish`;
    } else if (newsCount24h > 5) {
      // Elevated attention — mild caution
      value = -0.1;
      confidence = 0.4;
      detail = `Elevated news attention (${newsCount24h} articles): mild caution`;
    } else if (newsCount24h >= 1) {
      // Normal coverage
      value = 0;
      confidence = 0.3;
      detail = `Normal news coverage (${newsCount24h} articles)`;
    } else {
      // Under the radar
      value = 0;
      confidence = 0.3;
      detail = 'Under the radar: no recent news coverage';
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence,
      source: 'Social Volume',
      details: detail,
    };
  }
}
