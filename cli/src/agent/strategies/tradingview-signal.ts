/**
 * TradingView Signal Strategy
 *
 * Consumes coin analysis from the local TradingView MCP server and converts
 * it into a directional signal (-1 to +1).  Falls back to a zero-confidence
 * neutral signal when the MCP server is unavailable or the token is unmapped.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';
import { getCoinAnalysis, type TVAnalysis } from '../../providers/data/tradingview.js';

export class TradingViewSignalStrategy implements Strategy {
  name = 'tradingviewSignal';
  description = 'TradingView technical indicators via local MCP server (4h timeframe)';
  requiredData = [] as string[]; // No StrategyContext fields needed — uses own provider

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const analysis = await getCoinAnalysis(ctx.tokenId, '4h');

    if (!analysis) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.0,
        source: 'TradingView MCP',
        details: 'TV MCP unavailable or token unmapped',
      };
    }

    return this.buildSignal(analysis);
  }

  private buildSignal(tv: TVAnalysis): Signal {
    // Primary value: Recommend.All (-1 to +1) from TradingView summary
    let value = tv.recommendAll;

    // Fallback: derive from buy_sell_signal string if recommendAll is zero
    if (value === 0 && tv.buySellSignal.toLowerCase() !== 'neutral') {
      value = signalStringToValue(tv.buySellSignal);
    }

    // Confidence: proportion of indicators that agree with the direction
    let confidence = 0.5; // baseline
    if (tv.totalIndicators > 0) {
      const agreeingCount =
        value > 0
          ? tv.buyCount
          : value < 0
            ? tv.sellCount
            : tv.neutralCount;
      confidence = agreeingCount / tv.totalIndicators;
    }

    // Boost confidence when signal is extreme (Strong Buy / Strong Sell)
    const absValue = Math.abs(value);
    if (absValue >= 0.8) {
      confidence = Math.min(confidence + 0.1, 1.0);
    }

    const details = [
      `TV ${tv.timeframe}: ${tv.buySellSignal}`,
      `Recommend.All=${tv.recommendAll.toFixed(3)}`,
      `buy=${tv.buyCount} sell=${tv.sellCount} neutral=${tv.neutralCount}`,
    ].join('; ');

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.max(0.1, Math.min(confidence, 1.0)),
      source: 'TradingView MCP',
      details,
    };
  }
}

/**
 * Map a TV buy/sell signal label to a numeric value.
 */
function signalStringToValue(signal: string): number {
  const s = signal.toLowerCase().trim();
  if (s === 'strong buy') return 1.0;
  if (s === 'buy') return 0.5;
  if (s === 'neutral') return 0.0;
  if (s === 'sell') return -0.5;
  if (s === 'strong sell') return -1.0;
  return 0.0;
}
