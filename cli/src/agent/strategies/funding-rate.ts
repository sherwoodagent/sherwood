/**
 * Funding Rate Harvester Strategy
 * Looks at perpetual futures funding rates for arbitrage opportunities.
 * Currently a placeholder — requires external funding rate API integration.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

/**
 * Calculate annualized yield from an 8-hour funding rate.
 * Funding is paid 3x per day (every 8 hours).
 * @param rate8h - The 8-hour funding rate as a decimal (e.g., 0.0005 = 0.05%)
 * @returns Annualized yield as a decimal (e.g., 0.5475 = 54.75%)
 */
export function annualizedYieldFromFundingRate(rate8h: number): number {
  // 3 funding periods per day × 365 days = 1095 periods per year
  return rate8h * 3 * 365;
}

/**
 * Calculate expected return from funding rate arbitrage over a period.
 * @param rate8h - 8-hour funding rate as decimal
 * @param days - Holding period in days
 * @returns Expected return as decimal
 */
export function expectedReturnFromFunding(rate8h: number, days: number): number {
  return rate8h * 3 * days;
}

export class FundingRateStrategy implements Strategy {
  name = 'fundingRate';
  description = 'Identifies funding rate arbitrage opportunities in perp markets (requires external data source)';
  requiredData = ['fundingRateData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    // Check if funding rate data is available in the context
    // For now, this is a placeholder — funding rate data isn't provided by current providers
    const fundingData = ctx.fundingRateData;

    if (!fundingData) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.0,
        source: 'Funding Rate Harvester',
        details: 'No funding rate data available — requires external data source (Binance, Bybit, etc.)',
      };
    }

    const rate = fundingData.rate8h;
    const annualized = annualizedYieldFromFundingRate(rate);
    const ratePct = (rate * 100).toFixed(4);
    const annualizedPct = (annualized * 100).toFixed(1);
    const details: string[] = [];
    let value = 0;
    let confidence = 0.5;

    if (rate > 0.0005) {
      // High positive funding: longs pay shorts → market overleveraged long → bearish contrarian
      value = -0.5;
      confidence = 0.6;
      details.push(
        `High positive funding ${ratePct}% (annualized ${annualizedPct}%): overleveraged longs — bearish contrarian on ${fundingData.exchange}`,
      );
    } else if (rate > 0.0002) {
      // Mild positive funding: slightly overleveraged long → mildly bearish
      value = -0.3;
      confidence = 0.4;
      details.push(
        `Mild positive funding ${ratePct}% (annualized ${annualizedPct}%): longs paying shorts — mildly bearish`,
      );
    } else if (rate < -0.0005) {
      // High negative funding: shorts pay longs → market overleveraged short → bullish contrarian
      value = 0.5;
      confidence = 0.6;
      details.push(
        `High negative funding ${ratePct}% (annualized ${annualizedPct}%): overleveraged shorts — bullish contrarian on ${fundingData.exchange}`,
      );
    } else if (rate < -0.0002) {
      // Mild negative funding: slightly overleveraged short → mildly bullish
      value = 0.3;
      confidence = 0.4;
      details.push(
        `Mild negative funding ${ratePct}% (annualized ${annualizedPct}%): shorts paying longs — mildly bullish`,
      );
    } else {
      // Funding between -0.02% and 0.02%: no opportunity
      value = 0.0;
      confidence = 0.3;
      details.push(
        `Funding rate ${ratePct}% near neutral: no directional signal`,
      );
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence,
      source: 'Funding Rate Harvester',
      details: details.join('; '),
    };
  }
}
