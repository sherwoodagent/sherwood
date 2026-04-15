/**
 * Hyperliquid Flow Strategy
 * Combines exchange-native signals for maximum alpha:
 * - Funding rate arbitrage
 * - OI + price divergence
 * - Order book imbalance
 * - Whale trade flow
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class HyperliquidFlowStrategy implements Strategy {
  name = 'hyperliquidFlow';
  description = 'Exchange-native flow analysis using Hyperliquid funding, OI, order book, and whale trades';
  requiredData = ['hyperliquidData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const hlData = ctx.hyperliquidData;

    if (!hlData) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.0,
        source: 'Hyperliquid Flow',
        details: 'No Hyperliquid data available',
      };
    }

    const signals = [
      this.analyzeFundingRate(hlData.fundingRate),
      this.analyzeOIPriceDivergence(hlData.oiChangePct, hlData.markPrice, hlData.prevDayPrice),
      this.analyzeOrderBookImbalance(hlData.orderBookImbalance),
      this.analyzeWhaleFlow(hlData.largeTradesBias),
    ];

    // Combine signals with weights
    const weights = [0.25, 0.30, 0.25, 0.20]; // funding, OI+price, orderbook, whales
    let totalValue = 0;
    let totalWeight = 0;
    const details: string[] = [];

    for (let i = 0; i < signals.length; i++) {
      const signal = signals[i]!;
      const weight = weights[i]!;
      totalValue += signal.value * weight;
      totalWeight += weight;
      if (signal.details) details.push(signal.details);
    }

    const value = totalValue / totalWeight;

    // Calculate confidence
    let confidence = 0.6; // Base confidence (exchange-native data)
    if (hlData.volume24h > 100_000_000) confidence += 0.1; // High liquidity

    // Boost confidence if multiple signals agree
    const positiveSignals = signals.filter(s => s.value > 0.2).length;
    const negativeSignals = signals.filter(s => s.value < -0.2).length;
    if (positiveSignals >= 3 || negativeSignals >= 3) confidence += 0.1;

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.min(1.0, confidence),
      source: 'Hyperliquid Flow',
      details: details.join(' | '),
    };
  }

  /** Analyze funding rate for mean-reversion opportunities. */
  private analyzeFundingRate(rate: number): { value: number; details: string } {
    const ratePct = (rate * 100).toFixed(4);

    if (rate > 0.001) {
      // >0.1% funding: strong bearish (overleveraged longs)
      return {
        value: -0.8,
        details: `High positive funding ${ratePct}%: overleveraged longs → bearish`,
      };
    } else if (rate > 0.0003) {
      // >0.03% funding: bearish
      return {
        value: -0.6,
        details: `Elevated positive funding ${ratePct}%: longs paying → bearish`,
      };
    } else if (rate < -0.001) {
      // <-0.1% funding: strong bullish (overleveraged shorts)
      return {
        value: 0.8,
        details: `High negative funding ${ratePct}%: overleveraged shorts → bullish`,
      };
    } else if (rate < -0.0003) {
      // <-0.03% funding: bullish
      return {
        value: 0.6,
        details: `Elevated negative funding ${ratePct}%: shorts paying → bullish`,
      };
    } else {
      // Neutral funding
      return {
        value: 0.0,
        details: `Neutral funding ${ratePct}%: no directional signal`,
      };
    }
  }

  /** Analyze OI + price divergence patterns. */
  private analyzeOIPriceDivergence(oiChangePct: number, markPrice: number, prevDayPrice: number): { value: number; details: string } {
    const priceChange = ((markPrice - prevDayPrice) / prevDayPrice) * 100;
    const oiRising = oiChangePct > 1; // >1% OI increase
    const oiFalling = oiChangePct < -1; // >1% OI decrease
    const priceRising = priceChange > 1; // >1% price increase
    const priceFalling = priceChange < -1; // >1% price decrease

    if (oiRising && priceRising) {
      return {
        value: 0.6,
        details: `OI+${oiChangePct.toFixed(1)}% Price+${priceChange.toFixed(1)}%: strong trend → bullish`,
      };
    } else if (oiRising && priceFalling) {
      return {
        value: 0.3,
        details: `OI+${oiChangePct.toFixed(1)}% Price${priceChange.toFixed(1)}%: shorts building → potential squeeze`,
      };
    } else if (oiFalling && priceRising) {
      return {
        value: -0.3,
        details: `OI${oiChangePct.toFixed(1)}% Price+${priceChange.toFixed(1)}%: weak rally → potential trap`,
      };
    } else if (oiFalling && priceFalling) {
      return {
        value: 0.2,
        details: `OI${oiChangePct.toFixed(1)}% Price${priceChange.toFixed(1)}%: capitulation → potential bottom`,
      };
    } else {
      return {
        value: 0.0,
        details: `OI${oiChangePct.toFixed(1)}% Price${priceChange.toFixed(1)}%: no clear divergence`,
      };
    }
  }

  /** Analyze order book imbalance. */
  private analyzeOrderBookImbalance(imbalance: number): { value: number; details: string } {
    const imbalancePct = (imbalance * 100).toFixed(1);

    if (imbalance > 0.5) {
      return {
        value: 0.8,
        details: `Very heavy bids (${imbalancePct}%): strong demand → bullish`,
      };
    } else if (imbalance > 0.3) {
      return {
        value: 0.5,
        details: `Heavy bids (${imbalancePct}%): demand pressure → bullish`,
      };
    } else if (imbalance < -0.5) {
      return {
        value: -0.8,
        details: `Very heavy asks (${imbalancePct}%): strong supply → bearish`,
      };
    } else if (imbalance < -0.3) {
      return {
        value: -0.5,
        details: `Heavy asks (${imbalancePct}%): supply pressure → bearish`,
      };
    } else {
      return {
        value: 0.0,
        details: `Balanced orderbook (${imbalancePct}%): no directional bias`,
      };
    }
  }

  /** Analyze whale trade flow direction. */
  private analyzeWhaleFlow(bias: number): { value: number; details: string } {
    const biasPct = (bias * 100).toFixed(1);

    if (bias > 0.3) {
      return {
        value: 0.4,
        details: `Whales buying (${biasPct}%): smart money accumulation → bullish`,
      };
    } else if (bias < -0.3) {
      return {
        value: -0.4,
        details: `Whales selling (${biasPct}%): smart money distribution → bearish`,
      };
    } else {
      return {
        value: bias, // Scale linearly for smaller values
        details: `Whale flow (${biasPct}%): moderate directional bias`,
      };
    }
  }
}