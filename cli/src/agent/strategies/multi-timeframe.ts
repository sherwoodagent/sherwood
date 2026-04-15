/**
 * Multi-Timeframe Confluence Strategy
 * Analyzes the same token across multiple timeframes for signal confluence.
 * Strong signals occur when multiple timeframes agree on direction.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext, Candle } from './types.js';
import { calculateEMA, calculateRSI } from '../technical.js';
import { clamp } from '../utils.js';

interface TimeframeAnalysis {
  timeframe: string;
  trend: number;      // +1 bullish, 0 neutral, -1 bearish
  momentum: number;   // +1 bullish, 0 neutral, -1 bearish
  structure: number;  // +1 bullish, 0 neutral, -1 bearish
  score: number;      // combined score
}

export class MultiTimeframeStrategy implements Strategy {
  name = 'multiTimeframe';
  description = 'Multi-timeframe confluence analysis using daily, weekly, and short-term data';
  requiredData = ['candles'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    if (!ctx.candles || ctx.candles.length < 30) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.1,
        source: 'Multi-Timeframe',
        details: 'Insufficient candle data for multi-timeframe analysis (need 30+ daily candles)',
      };
    }

    const details: string[] = [];
    let value = 0;
    let confidence = 0.4;

    try {
      // Prepare timeframe data
      const dailyCandles = ctx.candles;
      const weeklyCandles = this.aggregateWeeklyCandles(dailyCandles);
      const shortTermCandles = dailyCandles.slice(-10); // Last 10 days as short-term proxy

      // Analyze each timeframe with appropriate periods
      const shortTermAnalysis = this.analyzeTimeframe(shortTermCandles, 'Short-term', 5);
      const dailyAnalysis = this.analyzeTimeframe(dailyCandles, 'Daily', 20);
      const weeklyAnalysis = this.analyzeTimeframe(weeklyCandles, 'Weekly', 5); // Reduced from 10

      const analyses = [shortTermAnalysis, dailyAnalysis, weeklyAnalysis];

      // Calculate confluence score
      const bullishCount = analyses.filter(a => a.score > 0).length;
      const bearishCount = analyses.filter(a => a.score < 0).length;
      const neutralCount = analyses.filter(a => a.score === 0).length;

      // Confluence scoring - adjusted for more realistic signals
      if (bullishCount === 3) {
        value = 0.8;
        confidence += 0.2;
        details.push('All timeframes bullish (strong confluence)');
      } else if (bearishCount === 3) {
        value = -0.8;
        confidence += 0.2;
        details.push('All timeframes bearish (strong confluence)');
      } else if (bullishCount === 2) {
        value = 0.4;
        confidence += 0.1;
        details.push('2 of 3 timeframes bullish');
      } else if (bearishCount === 2) {
        value = -0.4;
        confidence += 0.1;
        details.push('2 of 3 timeframes bearish');
      } else if (bullishCount > bearishCount) {
        value = 0.2;
        details.push('Majority bullish (weak confluence)');
      } else if (bearishCount > bullishCount) {
        value = -0.2;
        details.push('Majority bearish (weak confluence)');
      } else {
        value = 0.0;
        details.push('Mixed timeframe signals');
      }

      // Add timeframe breakdown details
      for (const analysis of analyses) {
        const score = analysis.score > 0 ? 'bullish' : analysis.score < 0 ? 'bearish' : 'neutral';
        details.push(`${analysis.timeframe}: ${score} (trend:${analysis.trend} momentum:${analysis.momentum} structure:${analysis.structure})`);
      }

      // Data quality factor
      const dataQualityFactor = Math.min(dailyCandles.length / 50, 1.0); // Full confidence at 50+ days
      confidence *= dataQualityFactor;

      if (dataQualityFactor < 1.0) {
        details.push(`Data quality: ${(dataQualityFactor * 100).toFixed(0)}% (${dailyCandles.length} days)`);
      }

    } catch (error) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.1,
        source: 'Multi-Timeframe',
        details: `Analysis error: ${(error as Error).message}`,
      };
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.min(Math.max(confidence, 0.1), 1.0),
      source: 'Multi-Timeframe',
      details: details.join('; '),
    };
  }

  private aggregateWeeklyCandles(dailyCandles: Candle[]): Candle[] {
    if (dailyCandles.length < 7) return [];

    const weeklyCandles: Candle[] = [];
    const sortedCandles = [...dailyCandles].sort((a, b) => a.timestamp - b.timestamp);

    // Group by ISO week
    const weekGroups = new Map<string, Candle[]>();

    for (const candle of sortedCandles) {
      const date = new Date(candle.timestamp);
      const year = date.getFullYear();
      const week = this.getISOWeek(date);
      const weekKey = `${year}-W${week.toString().padStart(2, '0')}`;

      if (!weekGroups.has(weekKey)) {
        weekGroups.set(weekKey, []);
      }
      weekGroups.get(weekKey)!.push(candle);
    }

    // Aggregate each week
    for (const [weekKey, candles] of weekGroups) {
      if (candles.length === 0) continue;

      const open = candles[0]!.open;
      const close = candles[candles.length - 1]!.close;
      const high = Math.max(...candles.map(c => c.high));
      const low = Math.min(...candles.map(c => c.low));
      const volume = candles.reduce((sum, c) => sum + c.volume, 0);
      const timestamp = candles[0]!.timestamp;

      weeklyCandles.push({ timestamp, open, high, low, close, volume });
    }

    return weeklyCandles.sort((a, b) => a.timestamp - b.timestamp);
  }

  private getISOWeek(date: Date): number {
    const tempDate = new Date(date.valueOf());
    const dayNumber = (date.getDay() + 6) % 7;
    tempDate.setDate(tempDate.getDate() - dayNumber + 3);
    const firstThursday = tempDate.valueOf();
    tempDate.setMonth(0, 1);
    if (tempDate.getDay() !== 4) {
      tempDate.setMonth(0, 1 + ((4 - tempDate.getDay()) + 7) % 7);
    }
    return 1 + Math.ceil((firstThursday - tempDate.valueOf()) / 604800000);
  }

  private analyzeTimeframe(candles: Candle[], label: string, emaPeriod: number): TimeframeAnalysis {
    if (candles.length < Math.max(emaPeriod * 0.7, 10)) { // More lenient requirement
      return {
        timeframe: label,
        trend: 0,
        momentum: 0,
        structure: 0,
        score: 0,
      };
    }

    // 1. Trend: price vs EMA
    const closes = candles.map(c => c.close);
    const emaValues = calculateEMA(closes, emaPeriod);
    const currentPrice = closes[closes.length - 1]!;
    const currentEMA = emaValues[emaValues.length - 1];

    let trend = 0;
    if (!isNaN(currentEMA!)) {
      trend = currentPrice > currentEMA! ? 1 : currentPrice < currentEMA! ? -1 : 0;
    }

    // 2. Momentum: RSI zones
    const rsiValues = calculateRSI(candles, 14);
    const currentRSI = rsiValues[rsiValues.length - 1];

    let momentum = 0;
    if (!isNaN(currentRSI!)) {
      if (currentRSI! > 60) momentum = 1;
      else if (currentRSI! < 40) momentum = -1;
      else momentum = 0;
    }

    // 3. Structure: last 3 candles pattern
    let structure = 0;
    if (candles.length >= 3) {
      const last3 = candles.slice(-3);
      const highs = last3.map(c => c.high);
      const lows = last3.map(c => c.low);

      const higherHighs = highs[1] > highs[0] && highs[2] > highs[1];
      const higherLows = lows[1] > lows[0] && lows[2] > lows[1];
      const lowerHighs = highs[1] < highs[0] && highs[2] < highs[1];
      const lowerLows = lows[1] < lows[0] && lows[2] < lows[1];

      if (higherHighs && higherLows) structure = 1;
      else if (lowerHighs && lowerLows) structure = -1;
      else structure = 0;
    }

    // Combine into score
    const score = trend + momentum + structure;

    return {
      timeframe: label,
      trend,
      momentum,
      structure,
      score: Math.sign(score) // Convert to -1, 0, or 1
    };
  }
}