/**
 * Execution pipeline - bridges scanner results to actionable trade proposals.
 * Converts high-confidence analysis into sized position recommendations.
 */

import type { TokenAnalysis } from "./index.js";
import type { TechnicalSignals } from "./technical.js";
import type { Candle } from "./technical.js";
import { calculateATR } from "./technical.js";

export type TradeAction = "LONG" | "SHORT";

export interface TradeProposal {
  tokenId: string;
  symbol: string;
  action: TradeAction;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSizeUsd: number;
  leverage: number;
  confidence: number;
  signals: string[];          // Top 3 signal names
  regime: string;
  timestamp: number;
}

export class ExecutionPipeline {

  /**
   * Generate trade proposals from analysis results.
   * Only creates proposals for high-confidence opportunities — uses the
   * regime-conditional BUY/SELL threshold from the decision (defaults to
   * ±0.4 if the decision lacks regime context).
   */
  /**
   * Score-weighted position sizing config.
   *
   * When enabled, risk percentage scales linearly with score magnitude
   * across the [floor, ceiling] band. Score at the floor → minRiskPct.
   * Score at or above the ceiling → maxRiskPct. Default OFF — risk
   * stays at fixed 2% so live behavior is unchanged until explicitly
   * enabled and validated.
   */
  static scaledSizing: {
    enabled: boolean;
    floor: number;     // score at which risk = minRiskPct
    ceiling: number;   // score at which risk = maxRiskPct
    minRiskPct: number;
    maxRiskPct: number;
  } = {
    enabled: false,
    floor: 0.30,
    ceiling: 0.60,
    minRiskPct: 0.005, // 0.5% — tiny exposure for marginal signals
    maxRiskPct: 0.02,  // 2%   — current fixed risk = ceiling
  };

  static generateProposals(
    analyses: TokenAnalysis[],
    portfolioValueUsd: number = 10000
  ): TradeProposal[] {
    const proposals: TradeProposal[] = [];

    for (const analysis of analyses) {
      const { decision, token, data } = analysis;

      // Skip HOLD signals
      if (decision.action === "HOLD") {
        continue;
      }

      // Filter: score must clear the regime-conditional action threshold
      // and confidence must exceed 50%. Falls back to ±0.4 for backward compat.
      // When scaledSizing is on, the floor drops to scaledSizing.floor — the
      // point is to take sub-threshold trades at proportionally smaller size,
      // not to filter them out before sizing kicks in.
      const baseBuyFloor = decision.thresholds?.buy ?? 0.4;
      const baseSellFloor = decision.thresholds?.sell ?? -0.4;
      const buyFloor = ExecutionPipeline.scaledSizing.enabled
        ? Math.min(baseBuyFloor, ExecutionPipeline.scaledSizing.floor)
        : baseBuyFloor;
      const sellFloor = ExecutionPipeline.scaledSizing.enabled
        ? Math.max(baseSellFloor, -ExecutionPipeline.scaledSizing.floor)
        : baseSellFloor;
      const clearsBuy = decision.score >= buyFloor;
      const clearsSell = decision.score <= sellFloor;
      if (!clearsBuy && !clearsSell) {
        continue;
      }
      if (decision.confidence <= 0.5) {
        continue;
      }

      // Determine trade direction
      const isLong = decision.score > 0;
      const action: TradeAction = isLong ? "LONG" : "SHORT";

      // Get current price (use entry price from technical data or mock)
      const entryPrice = this.getEntryPrice(data.technicalSignals);
      if (!entryPrice) continue;

      // Calculate ATR for stop loss
      const atr = this.getATR(data.technicalSignals);
      if (!atr) continue;

      // Calculate stop loss (entry +/- 2*ATR)
      const stopLoss = isLong
        ? entryPrice - (2 * atr)
        : entryPrice + (2 * atr);

      // Calculate take profit (2.5:1 R:R)
      const riskAmount = Math.abs(entryPrice - stopLoss);
      const takeProfit = isLong
        ? entryPrice + (2.5 * riskAmount)
        : entryPrice - (2.5 * riskAmount);

      // Position sizing — fixed 2% by default, score-scaled if enabled.
      // Score-scaled: bigger conviction → bigger size, smaller conviction → smaller size.
      // The point: take more sub-0.4 trades but with proportionally smaller exposure.
      let riskPercentage: number;
      if (ExecutionPipeline.scaledSizing.enabled) {
        const cfg = ExecutionPipeline.scaledSizing;
        const absScore = Math.abs(decision.score);
        const t = Math.min(1, Math.max(0, (absScore - cfg.floor) / (cfg.ceiling - cfg.floor)));
        riskPercentage = cfg.minRiskPct + t * (cfg.maxRiskPct - cfg.minRiskPct);
      } else {
        riskPercentage = 0.02;
      }
      const positionSizeUsd = (portfolioValueUsd * riskPercentage) / (Math.abs(entryPrice - stopLoss) / entryPrice);

      // Calculate leverage (size / max 10% portfolio allocation, capped at 5x)
      const maxAllocation = portfolioValueUsd * 0.10;
      const leverage = Math.min(5.0, positionSizeUsd / maxAllocation);

      // Get top 3 signals
      const topSignals = decision.signals
        .filter(s => Math.abs(s.value) > 0.05)
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
        .slice(0, 3)
        .map(s => s.source);

      // Get regime
      const regime = analysis.regime?.regime || "unknown";

      // Resolve token symbol (fallback to tokenId if not available)
      const symbol = this.resolveSymbol(token);

      const proposal: TradeProposal = {
        tokenId: token,
        symbol,
        action,
        entryPrice,
        stopLoss,
        takeProfit,
        positionSizeUsd,
        leverage,
        confidence: decision.confidence,
        signals: topSignals,
        regime,
        timestamp: Date.now(),
      };

      proposals.push(proposal);
    }

    return proposals.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Format trade proposals for human review.
   */
  static formatProposals(proposals: TradeProposal[]): string {
    if (proposals.length === 0) {
      return "📝 *TRADE PROPOSALS*\n\n_No actionable opportunities found._\n_Criteria: Score > 0.4, Confidence > 50%_";
    }

    const lines: string[] = [];
    lines.push("📝 *TRADE PROPOSALS*");
    lines.push("_⚠️ For review only - NO auto-execution_");

    for (const proposal of proposals.slice(0, 5)) {
      const directionEmoji = proposal.action === "LONG" ? "🟢" : "🔴";
      const confidenceBar = "█".repeat(Math.floor(proposal.confidence * 10));

      lines.push(`\n${directionEmoji} *${proposal.action} ${proposal.symbol}*`);
      lines.push(`📈 Entry: $${proposal.entryPrice.toFixed(4)}`);
      lines.push(`🛑 Stop: $${proposal.stopLoss.toFixed(4)} (${this.calculatePctChange(proposal.entryPrice, proposal.stopLoss)}%)`);
      lines.push(`🎯 Target: $${proposal.takeProfit.toFixed(4)} (${this.calculatePctChange(proposal.entryPrice, proposal.takeProfit)}%)`);
      lines.push(`💰 Size: $${proposal.positionSizeUsd.toFixed(0)} (${proposal.leverage.toFixed(1)}x leverage)`);
      lines.push(`✅ Confidence: ${(proposal.confidence * 100).toFixed(0)}% ${confidenceBar}`);

      // Top signals
      if (proposal.signals.length > 0) {
        lines.push(`🔍 Signals: ${proposal.signals.slice(0, 2).join(", ")}`);
      }

      // Market regime
      const regimeEmoji = proposal.regime === "trending-up" ? "📈" :
                         proposal.regime === "trending-down" ? "📉" :
                         proposal.regime === "ranging" ? "↔️" :
                         proposal.regime === "high-volatility" ? "🌋" : "🔄";
      lines.push(`${regimeEmoji} Regime: ${proposal.regime}`);
    }

    if (proposals.length > 5) {
      lines.push(`\n_...${proposals.length - 5} more proposals available_`);
    }

    lines.push(`\n_Generated: ${new Date().toLocaleTimeString()}_`);

    const result = lines.join("\n");

    // Respect character limits
    if (result.length > 4000) {
      return result.substring(0, 3900) + "\n\n_...truncated_";
    }

    return result;
  }

  /**
   * Extract entry price from technical signals or use fallback.
   */
  private static getEntryPrice(technicalSignals?: TechnicalSignals): number | null {
    if (!technicalSignals) return null;

    // Use VWAP as entry price if available, fallback to EMA8
    if (technicalSignals.vwap > 0) {
      return technicalSignals.vwap;
    }

    if (technicalSignals.ema.ema8 > 0) {
      return technicalSignals.ema.ema8;
    }

    return null;
  }

  /**
   * Extract ATR from technical signals.
   */
  private static getATR(technicalSignals?: TechnicalSignals): number | null {
    if (!technicalSignals) return null;
    return technicalSignals.atr > 0 ? technicalSignals.atr : null;
  }

  /**
   * Resolve token symbol from token ID.
   */
  private static resolveSymbol(tokenId: string): string {
    const symbolMap: Record<string, string> = {
      "bitcoin": "BTC",
      "ethereum": "ETH",
      "solana": "SOL",
      "aave": "AAVE",
      "uniswap": "UNI",
      "chainlink": "LINK",
      "polygon": "MATIC",
      "avalanche-2": "AVAX",
      "cardano": "ADA",
      "polkadot": "DOT",
    };

    return symbolMap[tokenId] || tokenId.toUpperCase().slice(0, 6);
  }

  /**
   * Calculate percentage change between two prices.
   */
  private static calculatePctChange(from: number, to: number): string {
    const change = ((to - from) / from) * 100;
    return change >= 0 ? `+${change.toFixed(1)}` : change.toFixed(1);
  }
}