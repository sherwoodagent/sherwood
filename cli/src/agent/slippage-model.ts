/**
 * Slippage and execution realism model for backtesting.
 * Applies market impact based on volatility, size, and liquidity.
 */

import { calculateATR } from './technical.js';
import type { Candle } from './technical.js';

export interface SlippageConfig {
  /** Base slippage in basis points (e.g., 8 = 0.08%) */
  slippageBps: number;
  /** Volatility multiplier for ATR-based volatility penalty */
  slippageVolMult: number;
  /** Size multiplier for position-size penalty */
  slippageSizeMult: number;
}

export interface ExecutionResult {
  /** Final execution price after slippage and fees */
  executionPrice: number;
  /** Market price before slippage */
  marketPrice: number;
  /** Total slippage as decimal (e.g., 0.001 = 0.1%) */
  totalSlippage: number;
  /** Breakdown of slippage components */
  breakdown: {
    baseSlippage: number;
    volatilityPenalty: number;
    sizePenalty: number;
    feesImpact: number;
  };
}

export const DEFAULT_SLIPPAGE_CONFIG: SlippageConfig = {
  slippageBps: 8,         // 0.08% base slippage
  slippageVolMult: 0.5,   // Moderate volatility impact
  slippageSizeMult: 1.0   // Full size penalty
};

/**
 * Calculate realistic execution price with slippage and market impact.
 *
 * Formula:
 * execution = market * (1 ± (base + volPenalty + sizePenalty + fees))
 *
 * Where:
 * - base = slippageBps / 10000
 * - volPenalty = (ATR/price) * volMult * sideMultiplier
 * - sizePenalty = (positionSize / proxyLiquidity) * sizeMult
 * - fees = trading fees (assumed ~0.05% for DEXs)
 * - sign is positive for buys (worse price), negative for sells
 */
export function calculateExecutionPrice(
  marketPrice: number,
  side: 'BUY' | 'SELL',
  positionSizeUsd: number,
  candles: Candle[],
  config: SlippageConfig = DEFAULT_SLIPPAGE_CONFIG
): ExecutionResult {
  const isBuy = side === 'BUY';
  const sideMultiplier = isBuy ? 1 : -1;

  // Base slippage
  const baseSlippage = config.slippageBps / 10000;

  // Volatility penalty based on ATR
  let volatilityPenalty = 0;
  if (candles.length >= 14) {
    const atrValues = calculateATR(candles, 14);
    const currentAtr = atrValues[atrValues.length - 1];

    if (currentAtr && !isNaN(currentAtr) && marketPrice > 0) {
      const atrRatio = currentAtr / marketPrice;
      volatilityPenalty = atrRatio * config.slippageVolMult;
    }
  }

  // Size penalty based on position size vs estimated liquidity
  let sizePenalty = 0;
  const proxyLiquidity = estimateLiquidity(candles, marketPrice);
  if (proxyLiquidity > 0 && positionSizeUsd > 0) {
    const sizeRatio = positionSizeUsd / proxyLiquidity;
    sizePenalty = Math.min(0.05, sizeRatio * config.slippageSizeMult); // Cap at 5%
  }

  // Trading fees (typical DEX fee)
  const feesImpact = 0.0005; // 0.05%

  // Total slippage (absolute value)
  const totalSlippageAbs = baseSlippage + volatilityPenalty + sizePenalty + feesImpact;

  // Apply directional slippage
  const totalSlippage = totalSlippageAbs * sideMultiplier;
  const executionPrice = marketPrice * (1 + totalSlippage);

  return {
    executionPrice,
    marketPrice,
    totalSlippage: totalSlippageAbs,
    breakdown: {
      baseSlippage,
      volatilityPenalty,
      sizePenalty,
      feesImpact
    }
  };
}

/**
 * Estimate available liquidity based on volume patterns.
 * Uses recent volume as a proxy for market depth.
 */
function estimateLiquidity(candles: Candle[], currentPrice: number): number {
  if (candles.length === 0 || currentPrice <= 0) {
    return 1000000; // Default $1M liquidity assumption
  }

  // Use recent volume data
  const recentCandles = candles.slice(-10); // Last 10 periods
  const validVolumes = recentCandles
    .map(c => c.volume * currentPrice) // Convert to USD volume
    .filter(v => v > 0);

  if (validVolumes.length === 0) {
    return 1000000; // Default if no volume data
  }

  // Average recent USD volume as liquidity proxy
  const avgVolumeUsd = validVolumes.reduce((a, b) => a + b, 0) / validVolumes.length;

  // Assume market depth is ~1-5% of daily volume
  const liquidityMultiplier = 0.03; // 3% of volume
  return avgVolumeUsd * liquidityMultiplier;
}

/**
 * Enhanced execution model that also considers bid-ask spread effects.
 */
export function calculateRealisticExecution(
  marketPrice: number,
  side: 'BUY' | 'SELL',
  positionSizeUsd: number,
  candles: Candle[],
  config: SlippageConfig = DEFAULT_SLIPPAGE_CONFIG
): ExecutionResult {
  const baseExecution = calculateExecutionPrice(marketPrice, side, positionSizeUsd, candles, config);

  // For very small positions, reduce slippage (taker vs maker dynamics)
  if (positionSizeUsd < 1000) {
    const reductionFactor = Math.max(0.1, positionSizeUsd / 1000);
    const reducedSlippage = baseExecution.totalSlippage * reductionFactor;
    const sideMultiplier = side === 'BUY' ? 1 : -1;

    return {
      ...baseExecution,
      totalSlippage: reducedSlippage,
      executionPrice: marketPrice * (1 + reducedSlippage * sideMultiplier),
      breakdown: {
        ...baseExecution.breakdown,
        baseSlippage: baseExecution.breakdown.baseSlippage * reductionFactor,
        volatilityPenalty: baseExecution.breakdown.volatilityPenalty * reductionFactor,
        sizePenalty: baseExecution.breakdown.sizePenalty * reductionFactor,
        feesImpact: baseExecution.breakdown.feesImpact * reductionFactor
      }
    };
  }

  return baseExecution;
}

/**
 * Format slippage breakdown for display.
 */
export function formatSlippageBreakdown(execution: ExecutionResult, positionSizeUsd: number): string {
  const lines: string[] = [];

  lines.push(`  Market Price:    $${execution.marketPrice.toFixed(4)}`);
  lines.push(`  Execution Price: $${execution.executionPrice.toFixed(4)}`);
  lines.push(`  Position Size:   $${positionSizeUsd.toLocaleString()}`);
  lines.push(`  Total Slippage:  ${(execution.totalSlippage * 100).toFixed(3)}%`);
  lines.push('');
  lines.push('  Breakdown:');
  lines.push(`    Base Slippage:     ${(execution.breakdown.baseSlippage * 100).toFixed(3)}%`);
  lines.push(`    Volatility Penalty: ${(execution.breakdown.volatilityPenalty * 100).toFixed(3)}%`);
  lines.push(`    Size Penalty:      ${(execution.breakdown.sizePenalty * 100).toFixed(3)}%`);
  lines.push(`    Fees Impact:       ${(execution.breakdown.feesImpact * 100).toFixed(3)}%`);

  return lines.join('\n');
}

/**
 * Calculate aggregate slippage impact over multiple trades.
 */
export function calculateAggregateSlippage(executions: ExecutionResult[]): {
  totalSlippageCost: number;
  avgSlippagePct: number;
  maxSlippagePct: number;
  slippageByComponent: {
    base: number;
    volatility: number;
    size: number;
    fees: number;
  };
} {
  if (executions.length === 0) {
    return {
      totalSlippageCost: 0,
      avgSlippagePct: 0,
      maxSlippagePct: 0,
      slippageByComponent: { base: 0, volatility: 0, size: 0, fees: 0 }
    };
  }

  let totalSlippageCost = 0;
  let totalSlippagePct = 0;
  let maxSlippagePct = 0;

  const componentTotals = { base: 0, volatility: 0, size: 0, fees: 0 };

  for (const exec of executions) {
    const slippageCost = Math.abs(exec.executionPrice - exec.marketPrice);
    totalSlippageCost += slippageCost;

    totalSlippagePct += exec.totalSlippage;
    maxSlippagePct = Math.max(maxSlippagePct, exec.totalSlippage);

    componentTotals.base += exec.breakdown.baseSlippage;
    componentTotals.volatility += exec.breakdown.volatilityPenalty;
    componentTotals.size += exec.breakdown.sizePenalty;
    componentTotals.fees += exec.breakdown.feesImpact;
  }

  return {
    totalSlippageCost,
    avgSlippagePct: totalSlippagePct / executions.length,
    maxSlippagePct,
    slippageByComponent: {
      base: componentTotals.base / executions.length,
      volatility: componentTotals.volatility / executions.length,
      size: componentTotals.size / executions.length,
      fees: componentTotals.fees / executions.length
    }
  };
}