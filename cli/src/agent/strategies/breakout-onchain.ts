/**
 * Breakout + On-Chain Confirmation Strategy
 * Detects price breakouts confirmed by volume and optionally by smart money flow.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext, Candle } from './types.js';
import { clamp } from '../utils.js';

function detect20DayBreakout(candles: Candle[]): { direction: 'up' | 'down' | 'none'; volumeConfirmed: boolean } {
  if (candles.length < 21) return { direction: 'none', volumeConfirmed: false };

  const lookback = candles.slice(-21, -1); // previous 20 candles (excluding latest)
  const latest = candles[candles.length - 1]!;

  const high20 = Math.max(...lookback.map(c => c.high));
  const low20 = Math.min(...lookback.map(c => c.low));

  // Volume confirmation: latest volume > 2x 20-period average
  const avgVolume = lookback.reduce((sum, c) => sum + c.volume, 0) / lookback.length;
  const volumeConfirmed = avgVolume > 0 && latest.volume > avgVolume * 2;

  if (latest.close > high20) {
    return { direction: 'up', volumeConfirmed };
  } else if (latest.close < low20) {
    return { direction: 'down', volumeConfirmed };
  }

  return { direction: 'none', volumeConfirmed: false };
}

function checkEmaAlignment(technicals: { ema: { ema8: number; ema21: number; ema50: number } }): 'bullish' | 'bearish' | 'neutral' {
  const { ema8, ema21, ema50 } = technicals.ema;
  if (isNaN(ema8) || isNaN(ema21) || isNaN(ema50)) return 'neutral';

  if (ema8 > ema21 && ema21 > ema50) return 'bullish';
  if (ema8 < ema21 && ema21 < ema50) return 'bearish';
  return 'neutral';
}

export class BreakoutOnChainStrategy implements Strategy {
  name = 'breakoutOnChain';
  description = 'Detects 20-day breakouts with volume confirmation and optional smart-money support';
  requiredData = ['candles', 'technicals'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    if (!ctx.candles || ctx.candles.length < 21) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.1,
        source: 'Breakout + On-Chain',
        details: 'Insufficient candle data for breakout detection (need 21+)',
      };
    }

    const details: string[] = [];
    let value = 0;
    let confidence = 0.4;

    // Detect breakout
    const breakout = detect20DayBreakout(ctx.candles);

    if (breakout.direction === 'none') {
      details.push('No 20-day breakout detected (ranging)');

      // Still check EMA alignment for a mild signal
      if (ctx.technicals) {
        const ema = checkEmaAlignment(ctx.technicals);
        if (ema === 'bullish') {
          value = 0.1;
          details.push('EMA alignment bullish (8>21>50)');
        } else if (ema === 'bearish') {
          value = -0.1;
          details.push('EMA alignment bearish (8<21<50)');
        }
      }

      return {
        name: this.name,
        value,
        confidence: 0.3,
        source: 'Breakout + On-Chain',
        details: details.join('; '),
      };
    }

    // Breakout detected
    if (breakout.direction === 'up') {
      value = breakout.volumeConfirmed ? 0.8 : 0.5;
      confidence = breakout.volumeConfirmed ? 0.7 : 0.5;
      details.push(`Bullish 20-day breakout${breakout.volumeConfirmed ? ' with volume confirmation (>2x avg)' : ' (low volume — caution)'}`);
    } else {
      value = breakout.volumeConfirmed ? -0.8 : -0.5;
      confidence = breakout.volumeConfirmed ? 0.7 : 0.5;
      details.push(`Bearish 20-day breakdown${breakout.volumeConfirmed ? ' with volume confirmation (>2x avg)' : ' (low volume — caution)'}`);
    }

    // EMA alignment bonus
    if (ctx.technicals) {
      const ema = checkEmaAlignment(ctx.technicals);
      if ((ema === 'bullish' && value > 0) || (ema === 'bearish' && value < 0)) {
        const bonus = value > 0 ? 0.2 : -0.2;
        value = clamp(value + bonus);
        confidence += 0.1;
        details.push(`EMA alignment confirms direction (+${Math.abs(bonus).toFixed(1)})`);
      } else if ((ema === 'bearish' && value > 0) || (ema === 'bullish' && value < 0)) {
        details.push('EMA alignment contradicts breakout — mixed signal');
        confidence -= 0.1;
      }
    }

    // Nansen smart money confirmation (optional)
    if (ctx.nansenData) {
      const data = ctx.nansenData as Record<string, unknown>;
      const flows = data.flows as Array<Record<string, unknown>> | undefined;
      if (flows && flows.length > 0) {
        const netflow = flows.reduce(
          (sum, f) => sum + (Number(f.netflow ?? f.net_flow ?? 0)),
          0,
        );
        // Negative netflow = buying, positive = selling
        const smartMoneyBuying = netflow < 0;
        const smartMoneySelling = netflow > 0;

        if ((smartMoneyBuying && value > 0) || (smartMoneySelling && value < 0)) {
          const bonus = value > 0 ? 0.2 : -0.2;
          value = clamp(value + bonus);
          confidence += 0.1;
          details.push(`Smart money confirms breakout direction (+${Math.abs(bonus).toFixed(1)})`);
        } else if ((smartMoneySelling && value > 0) || (smartMoneyBuying && value < 0)) {
          details.push('Smart money diverges from breakout — caution');
          confidence -= 0.05;
        }
      }
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.min(Math.max(confidence, 0.1), 1.0),
      source: 'Breakout + On-Chain',
      details: details.join('; '),
    };
  }
}
