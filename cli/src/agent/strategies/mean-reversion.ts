/**
 * Mean Reversion Strategy — for range-bound markets.
 *
 * Detect mean-reverting regime: price oscillating around SMA(20)
 * Buy signal: price below lower BB + RSI < 30 + volume spike (capitulation)
 * Sell signal: price above upper BB + RSI > 70 + volume spike (euphoria)
 * Only active when BB width is narrow (not trending) — BB squeeze must NOT be active
 * Filter: skip if EMA(50) > EMA(200) and we'd be shorting (don't fight the trend)
 * Confidence: 0.6 base, +0.1 if volume confirms, -0.2 if trending market
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class MeanReversionStrategy implements Strategy {
  name = 'meanReversion';
  description = 'Mean reversion strategy for range-bound markets using BB + RSI + volume';
  requiredData = ['candles', 'technicals'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    if (!ctx.candles || !ctx.technicals || ctx.candles.length < 21) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.1,
        source: 'Mean Reversion',
        details: 'Insufficient data for mean reversion analysis',
      };
    }

    const tech = ctx.technicals;
    const details: string[] = [];
    let value = 0;
    let confidence = 0.6;

    // Get current price (latest candle close)
    const currentPrice = ctx.candles[ctx.candles.length - 1]!.close;

    // Check if BB squeeze is active — if so, this strategy shouldn't fire
    // (squeeze means compression, not a mean-reverting environment)
    if (tech.bb.squeeze) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.2,
        source: 'Mean Reversion',
        details: 'BB squeeze active — awaiting breakout, mean reversion inactive',
      };
    }

    // Check BB width — only active in narrow-to-moderate width (not strongly trending)
    // BB width > 0.15 suggests strong trend
    const isTrending = tech.bb.width > 0.15;
    if (isTrending) {
      confidence -= 0.2;
      details.push(`BB width ${tech.bb.width.toFixed(4)} (trending market, reduced confidence)`);
    } else {
      details.push(`BB width ${tech.bb.width.toFixed(4)} (range-bound, favorable)`);
    }

    // Detect EMA trend direction
    const ema50 = tech.ema.ema50;
    const ema200 = tech.ema.ema200;
    const bullishTrend = !isNaN(ema50) && !isNaN(ema200) && ema50 > ema200;
    const bearishTrend = !isNaN(ema50) && !isNaN(ema200) && ema50 < ema200;

    // Volume spike detection
    const volumeSpike = tech.volume.ratio > 1.5;

    // ── Buy Signal: price below lower BB + RSI < 30 (capitulation) ──
    if (currentPrice < tech.bb.lower && tech.rsi < 30) {
      value = 0.6;
      details.push(`Price $${currentPrice.toFixed(2)} below lower BB $${tech.bb.lower.toFixed(2)}`);
      details.push(`RSI ${tech.rsi.toFixed(1)} oversold`);

      if (volumeSpike) {
        value += 0.1;
        confidence += 0.1;
        details.push(`Volume spike ${tech.volume.ratio.toFixed(1)}x (capitulation confirmed)`);
      }

      // Don't fight bearish trend with buy — but still allow it with reduced confidence
      if (bearishTrend) {
        confidence -= 0.15;
        details.push('Bearish EMA trend — reduced confidence on buy');
      } else if (bullishTrend) {
        confidence += 0.1;
        details.push('Bullish EMA trend supports mean reversion buy');
      }
    }
    // ── Sell Signal: price above upper BB + RSI > 70 (euphoria) ──
    else if (currentPrice > tech.bb.upper && tech.rsi > 70) {
      value = -0.6;
      details.push(`Price $${currentPrice.toFixed(2)} above upper BB $${tech.bb.upper.toFixed(2)}`);
      details.push(`RSI ${tech.rsi.toFixed(1)} overbought`);

      if (volumeSpike) {
        value -= 0.1;
        confidence += 0.1;
        details.push(`Volume spike ${tech.volume.ratio.toFixed(1)}x (euphoria confirmed)`);
      }

      // Don't fight bullish trend with sell — filter
      if (bullishTrend) {
        confidence -= 0.15;
        details.push('Bullish EMA trend — reduced confidence on sell');
      } else if (bearishTrend) {
        confidence += 0.1;
        details.push('Bearish EMA trend supports mean reversion sell');
      }
    }
    // ── Mild signals when only partially met ──
    else if (currentPrice < tech.bb.lower) {
      value = 0.2;
      details.push(`Price below lower BB but RSI ${tech.rsi.toFixed(1)} not oversold yet`);
    } else if (currentPrice > tech.bb.upper) {
      value = -0.2;
      details.push(`Price above upper BB but RSI ${tech.rsi.toFixed(1)} not overbought yet`);
    } else if (tech.rsi < 30) {
      value = 0.15;
      details.push(`RSI ${tech.rsi.toFixed(1)} oversold but price within BB range`);
    } else if (tech.rsi > 70) {
      value = -0.15;
      details.push(`RSI ${tech.rsi.toFixed(1)} overbought but price within BB range`);
    } else {
      details.push('No mean reversion signal — price within normal range');
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.min(Math.max(confidence, 0.1), 1.0),
      source: 'Mean Reversion',
      details: details.join('; '),
    };
  }
}
