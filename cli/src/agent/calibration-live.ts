import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import type { SignalLogEntry } from './signal-logger.js';
import type { TradeRecord } from './portfolio.js';

/**
 * Live calibration factors based on historical regime-specific performance.
 * Tracks rolling outcome stats by (token, regime, action family) and provides
 * calibration factors to adjust confidence and scoring before final decisions.
 */

export interface RegimeOutcome {
  regime: string;
  actionFamily: 'BUY' | 'SELL' | 'HOLD';
  outcomes: Array<{
    timestamp: number;
    tokenId: string;
    success: boolean;
    pnlPercent: number;
    duration: number; // hours held
  }>;
}

export interface CalibrationStats {
  sampleCount: number;
  successRate: number;
  avgPnlPercent: number;
  avgDuration: number;
  confidence: number; // 0-1, based on sample size and consistency
}

export interface CalibrationFactor {
  factor: number; // 0.7 - 1.2
  reason: string;
  stats: CalibrationStats;
}

export interface UncertaintyMetrics {
  scoreDispersion: number; // 0-1, std dev of signal scores
  signalAgreement: number; // 0-1, how much signals agree
  recentVolatility: number; // 0-1, price volatility factor
  level: 'low' | 'medium' | 'high';
  sizeMultiplier: number; // 0.5, 0.8, 1.0
}

export class LiveCalibrator {
  private readonly MIN_SAMPLE_SIZE = 20;
  private readonly LOOKBACK_DAYS = 30;
  private readonly NEUTRAL_FACTOR = 1.0;
  private readonly MIN_FACTOR = 0.7;
  private readonly MAX_FACTOR = 1.2;

  private regimeOutcomes: Map<string, RegimeOutcome[]> = new Map();
  private lastUpdated = 0;

  constructor(
    private readonly agentDir: string = path.join(homedir(), '.sherwood', 'agent')
  ) {}

  /**
   * Get calibration factor for a specific (token, regime, action) combination
   */
  public getCalibrationFactor(
    tokenId: string,
    regime: string,
    actionFamily: 'BUY' | 'SELL' | 'HOLD'
  ): CalibrationFactor {
    this.updateOutcomesIfStale();

    const key = this.getOutcomeKey(tokenId, regime, actionFamily);
    const stats = this.calculateStats(key);

    if (stats.sampleCount < this.MIN_SAMPLE_SIZE) {
      return {
        factor: this.NEUTRAL_FACTOR,
        reason: `Insufficient samples (${stats.sampleCount} < ${this.MIN_SAMPLE_SIZE})`,
        stats
      };
    }

    // Base factor on success rate and average PnL
    let factor = this.NEUTRAL_FACTOR;

    // Adjust based on success rate (0.5 = neutral)
    const successRateAdjustment = (stats.successRate - 0.5) * 0.3;

    // Adjust based on average PnL (small positive bias)
    const pnlAdjustment = Math.max(-0.1, Math.min(0.1, stats.avgPnlPercent * 0.5));

    // Confidence scaling - reduce adjustments if low confidence
    const confidenceScale = Math.min(1.0, stats.confidence);

    factor += (successRateAdjustment + pnlAdjustment) * confidenceScale;

    // Clamp to bounds
    factor = Math.max(this.MIN_FACTOR, Math.min(this.MAX_FACTOR, factor));

    const reason = this.buildReason(stats, successRateAdjustment, pnlAdjustment, confidenceScale);

    return { factor, reason, stats };
  }

  /**
   * Calculate uncertainty metrics from recent signal dispersion and agreement
   */
  public calculateUncertainty(
    signals: Array<{ name: string; value: number; confidence: number }>,
    recentPrices: number[],
    tokenId: string
  ): UncertaintyMetrics {
    // Score dispersion - how spread out are the signal values?
    const signalValues = signals.map(s => s.value);
    const scoreDispersion = this.calculateStdDev(signalValues);

    // Signal agreement - do signals point in same direction?
    const positiveSignals = signalValues.filter(v => v > 0.1).length;
    const negativeSignals = signalValues.filter(v => v < -0.1).length;
    const neutralSignals = signalValues.length - positiveSignals - negativeSignals;

    const totalSignals = signalValues.length;
    const maxDirectional = Math.max(positiveSignals, negativeSignals);
    const signalAgreement = totalSignals > 0 ? maxDirectional / totalSignals : 0;

    // Recent volatility from prices
    const recentVolatility = recentPrices.length > 1 ?
      this.calculatePriceVolatility(recentPrices) : 0;

    // Combine into uncertainty level
    const uncertaintyScore = this.combineUncertaintyFactors(
      scoreDispersion,
      1 - signalAgreement, // invert agreement to get disagreement
      recentVolatility
    );

    const level = this.categorizeUncertainty(uncertaintyScore);
    const sizeMultiplier = this.getSizeMultiplier(level);

    return {
      scoreDispersion,
      signalAgreement,
      recentVolatility,
      level,
      sizeMultiplier
    };
  }

  /**
   * Update regime outcomes from signal history and trade history
   */
  private updateOutcomesIfStale(): void {
    const now = Date.now();
    if (now - this.lastUpdated < 5 * 60 * 1000) return; // 5 min cache

    try {
      this.loadOutcomesFromHistory();
      this.lastUpdated = now;
    } catch (error) {
      console.warn('Failed to update calibration outcomes:', error);
    }
  }

  private loadOutcomesFromHistory(): void {
    const signalHistoryPath = path.join(this.agentDir, 'signal-history.jsonl');
    const tradesPath = path.join(this.agentDir, 'trades.json');

    if (!fs.existsSync(signalHistoryPath) || !fs.existsSync(tradesPath)) {
      return;
    }

    // Load trade outcomes
    const tradesData = fs.readFileSync(tradesPath, 'utf-8');
    const trades: TradeRecord[] = JSON.parse(tradesData);
    const tradesByToken = new Map<string, TradeRecord[]>();

    trades.forEach(trade => {
      if (!tradesByToken.has(trade.tokenId)) {
        tradesByToken.set(trade.tokenId, []);
      }
      tradesByToken.get(trade.tokenId)!.push(trade);
    });

    // Load signal history and match to outcomes
    const signalLines = fs.readFileSync(signalHistoryPath, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .slice(-10000); // Last 10k signals for performance

    const cutoffTime = Date.now() - (this.LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    this.regimeOutcomes.clear();

    signalLines.forEach(line => {
      try {
        const entry: SignalLogEntry = JSON.parse(line);
        const timestamp = new Date(entry.timestamp).getTime();

        if (timestamp < cutoffTime) return;
        if (!entry.regime || entry.decision === 'HOLD') return;

        const actionFamily = entry.decision.includes('BUY') ? 'BUY' : 'SELL';
        const outcome = this.findMatchingOutcome(entry, tradesByToken.get(entry.tokenId) || []);

        if (outcome) {
          this.addOutcome(entry.tokenId, entry.regime, actionFamily, {
            timestamp,
            tokenId: entry.tokenId,
            success: outcome.success,
            pnlPercent: outcome.pnlPercent,
            duration: outcome.duration
          });
        }
      } catch (error) {
        // Skip malformed lines
      }
    });
  }

  private findMatchingOutcome(
    signal: SignalLogEntry,
    trades: TradeRecord[]
  ): { success: boolean; pnlPercent: number; duration: number } | null {
    const signalTime = new Date(signal.timestamp).getTime();

    // Find trade that started within 1 hour of signal
    const matchingTrade = trades.find(trade => {
      const entryTime = trade.entryTimestamp;
      const timeDiff = Math.abs(entryTime - signalTime);
      return timeDiff < 60 * 60 * 1000; // 1 hour window
    });

    if (!matchingTrade || !matchingTrade.exitTimestamp) {
      return null;
    }

    const duration = matchingTrade.duration / 60 / 60; // convert ms to hours
    const success = matchingTrade.pnlPercent > 0;

    return {
      success,
      pnlPercent: matchingTrade.pnlPercent,
      duration
    };
  }

  private addOutcome(
    tokenId: string,
    regime: string,
    actionFamily: 'BUY' | 'SELL' | 'HOLD',
    outcome: RegimeOutcome['outcomes'][0]
  ): void {
    const key = this.getOutcomeKey(tokenId, regime, actionFamily);

    if (!this.regimeOutcomes.has(key)) {
      this.regimeOutcomes.set(key, []);
    }

    const outcomes = this.regimeOutcomes.get(key)!;
    outcomes.push({
      regime,
      actionFamily,
      outcomes: [outcome]
    });

    // Keep only recent outcomes
    const cutoffTime = Date.now() - (this.LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    this.regimeOutcomes.set(key, outcomes.filter(o =>
      o.outcomes[0].timestamp > cutoffTime
    ));
  }

  private calculateStats(key: string): CalibrationStats {
    const outcomes = this.regimeOutcomes.get(key) || [];
    const flatOutcomes = outcomes.flatMap(o => o.outcomes);

    if (flatOutcomes.length === 0) {
      return {
        sampleCount: 0,
        successRate: 0.5,
        avgPnlPercent: 0,
        avgDuration: 0,
        confidence: 0
      };
    }

    const successes = flatOutcomes.filter(o => o.success).length;
    const successRate = successes / flatOutcomes.length;
    const avgPnlPercent = flatOutcomes.reduce((sum, o) => sum + o.pnlPercent, 0) / flatOutcomes.length;
    const avgDuration = flatOutcomes.reduce((sum, o) => sum + o.duration, 0) / flatOutcomes.length;

    // Confidence based on sample size (diminishing returns)
    const confidence = Math.min(1.0, Math.sqrt(flatOutcomes.length / this.MIN_SAMPLE_SIZE));

    return {
      sampleCount: flatOutcomes.length,
      successRate,
      avgPnlPercent,
      avgDuration,
      confidence
    };
  }

  private getOutcomeKey(tokenId: string, regime: string, actionFamily: string): string {
    return `${tokenId}:${regime}:${actionFamily}`;
  }

  private buildReason(
    stats: CalibrationStats,
    successAdj: number,
    pnlAdj: number,
    confidenceScale: number
  ): string {
    const parts = [];

    if (successAdj > 0.05) {
      parts.push(`high success rate (${(stats.successRate * 100).toFixed(1)}%)`);
    } else if (successAdj < -0.05) {
      parts.push(`low success rate (${(stats.successRate * 100).toFixed(1)}%)`);
    }

    if (pnlAdj > 0.02) {
      parts.push(`positive avg PnL (${(stats.avgPnlPercent * 100).toFixed(1)}%)`);
    } else if (pnlAdj < -0.02) {
      parts.push(`negative avg PnL (${(stats.avgPnlPercent * 100).toFixed(1)}%)`);
    }

    if (confidenceScale < 0.8) {
      parts.push(`moderate confidence (${stats.sampleCount} samples)`);
    }

    return parts.length > 0 ? parts.join(', ') : 'neutral performance';
  }

  private calculateStdDev(values: number[]): number {
    if (values.length === 0) return 0;

    const mean = values.reduce((sum, val) => sum + val, 0) / values.length;
    const squaredDiffs = values.map(val => Math.pow(val - mean, 2));
    const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / values.length;

    return Math.sqrt(variance);
  }

  private calculatePriceVolatility(prices: number[]): number {
    if (prices.length < 2) return 0;

    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }

    return this.calculateStdDev(returns);
  }

  private combineUncertaintyFactors(
    scoreDispersion: number,
    signalDisagreement: number,
    volatility: number
  ): number {
    // Weighted combination of uncertainty factors
    return (scoreDispersion * 0.4) + (signalDisagreement * 0.4) + (volatility * 0.2);
  }

  private categorizeUncertainty(score: number): 'low' | 'medium' | 'high' {
    if (score < 0.3) return 'low';
    if (score < 0.6) return 'medium';
    return 'high';
  }

  private getSizeMultiplier(level: 'low' | 'medium' | 'high'): number {
    switch (level) {
      case 'low': return 1.0;
      case 'medium': return 0.8;
      case 'high': return 0.5;
    }
  }
}