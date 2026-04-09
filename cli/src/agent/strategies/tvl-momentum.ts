/**
 * TVL Momentum Strategy
 * Analyzes Total Value Locked growth trends from DefiLlama data.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

function calculateTvlGrowthWoW(tvlData: any): number | null {
  // tvlData may be a historical array or an object with tvl history
  let history: Array<{ date?: number; totalLiquidityUSD?: number; tvl?: number }> | undefined;

  if (Array.isArray(tvlData)) {
    history = tvlData;
  } else if (tvlData?.tvl && Array.isArray(tvlData.tvl)) {
    history = tvlData.tvl;
  } else if (tvlData?.chainTvls) {
    // DefiLlama protocol response — try to extract combined TVL
    const combined = Object.values(tvlData.chainTvls as Record<string, any>)
      .find((chain: any) => chain?.tvl && Array.isArray(chain.tvl));
    if (combined) history = (combined as any).tvl;
  }

  if (!history || history.length < 8) return null;

  // Get current TVL and TVL from ~7 days ago
  const sortedHistory = [...history].sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
  const current = sortedHistory[sortedHistory.length - 1];
  const weekAgo = sortedHistory[Math.max(0, sortedHistory.length - 8)];

  const currentTvl = current?.totalLiquidityUSD ?? current?.tvl ?? 0;
  const weekAgoTvl = weekAgo?.totalLiquidityUSD ?? weekAgo?.tvl ?? 0;

  if (weekAgoTvl === 0) return null;

  return (currentTvl - weekAgoTvl) / weekAgoTvl;
}

function getCurrentTvl(tvlData: any): number | null {
  if (typeof tvlData === 'number') return tvlData;
  if (Array.isArray(tvlData) && tvlData.length > 0) {
    const last = tvlData[tvlData.length - 1];
    return last?.totalLiquidityUSD ?? last?.tvl ?? null;
  }
  if (tvlData?.tvl) {
    if (typeof tvlData.tvl === 'number') return tvlData.tvl;
    if (Array.isArray(tvlData.tvl) && tvlData.tvl.length > 0) {
      const last = tvlData.tvl[tvlData.tvl.length - 1];
      return last?.totalLiquidityUSD ?? last?.tvl ?? null;
    }
  }
  return null;
}

export class TvlMomentumStrategy implements Strategy {
  name = 'tvlMomentum';
  description = 'Analyzes TVL growth trends — bullish on rising TVL, bearish on declining';
  requiredData = ['tvlData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    if (!ctx.tvlData) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.1,
        source: 'TVL Momentum',
        details: 'No TVL data available (token may not be a DeFi protocol)',
      };
    }

    const details: string[] = [];
    let value = 0;
    let confidence = 0.4; // Base low confidence — TVL can be gamed

    const growthWoW = calculateTvlGrowthWoW(ctx.tvlData);

    if (growthWoW === null) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.15,
        source: 'TVL Momentum',
        details: 'Insufficient TVL history for momentum calculation',
      };
    }

    const growthPct = growthWoW * 100;

    if (growthWoW > 0.20) {
      // Strong bullish: >20% WoW growth
      value = 0.6 + Math.min((growthWoW - 0.20) / 0.30, 0.2); // 0.6 to 0.8
      confidence = 0.5;
      details.push(`TVL surging +${growthPct.toFixed(1)}% WoW: strong bullish momentum`);
    } else if (growthWoW > 0.10) {
      // Bullish: >10% WoW growth
      value = 0.3 + ((growthWoW - 0.10) / 0.10) * 0.3; // 0.3 to 0.6
      confidence = 0.45;
      details.push(`TVL growing +${growthPct.toFixed(1)}% WoW: bullish momentum`);
    } else if (growthWoW >= -0.02 && growthWoW <= 0.02) {
      // Flat: ±2%
      value = 0.0;
      confidence = 0.3;
      details.push(`TVL flat (${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(1)}% WoW): neutral`);
    } else if (growthWoW > 0.02) {
      // Mild growth: 2-10%
      value = 0.1 + ((growthWoW - 0.02) / 0.08) * 0.2; // 0.1 to 0.3
      details.push(`TVL mildly growing +${growthPct.toFixed(1)}% WoW`);
    } else if (growthWoW >= -0.05) {
      // Mild decline: -2% to -5%
      value = -0.1 - ((Math.abs(growthWoW) - 0.02) / 0.03) * 0.2;
      details.push(`TVL mildly declining ${growthPct.toFixed(1)}% WoW`);
    } else if (growthWoW >= -0.15) {
      // Bearish: -5% to -15%
      value = -(0.3 + ((Math.abs(growthWoW) - 0.05) / 0.10) * 0.3); // -0.3 to -0.6
      confidence = 0.45;
      details.push(`TVL declining ${growthPct.toFixed(1)}% WoW: bearish momentum`);
    } else {
      // Strong bearish: >-15%
      value = -(0.7 + Math.min((Math.abs(growthWoW) - 0.15) / 0.15, 0.2)); // -0.7 to -0.9
      confidence = 0.5;
      details.push(`TVL crashing ${growthPct.toFixed(1)}% WoW: strong bearish momentum`);
    }

    // Mcap/TVL ratio consideration
    if (ctx.marketData) {
      const mcap = ctx.marketData.market_cap?.usd ?? ctx.marketData.usd_market_cap;
      const currentTvl = getCurrentTvl(ctx.tvlData);
      if (mcap && currentTvl && currentTvl > 0) {
        const ratio = mcap / currentTvl;
        if (ratio < 1.0) {
          value = clamp(value + 0.15);
          details.push(`Mcap/TVL ratio ${ratio.toFixed(2)} < 1.0 (potentially undervalued)`);
        } else if (ratio > 10) {
          value = clamp(value - 0.1);
          details.push(`Mcap/TVL ratio ${ratio.toFixed(1)} (potentially overvalued)`);
        }
      }
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.min(confidence, 1.0),
      source: 'TVL Momentum',
      details: details.join('; '),
    };
  }
}
