/**
 * Whale Intent Classifier — distinguishes operational whale transfers
 * (ETF AP flows, exchange rebalancing) from directional positioning.
 *
 * Key insight from X research: the edge is NOT "big transfer happened"
 * but WHAT TYPE of transfer it is. ETF authorized participants move
 * BTC/ETH regularly for operational reasons (creations/redemptions) —
 * these are noise. Discretionary smart-money moves at unusual times,
 * sizes, or patterns are the real signal.
 *
 * Intent classification heuristics:
 *   - High trader count + consistent direction = consensus positioning (strong)
 *   - Few traders + large size = single whale (moderate, could be operational)
 *   - Flow aligned with HL perp positioning = cross-venue confirmation (very strong)
 *   - Flow opposing HL perp positioning = divergence (caution)
 *
 * Data sources:
 *   - Nansen smart-money netflow (aggregate)
 *   - Nansen HL perp trades (cross-venue confirmation)
 *   - Hyperliquid funding rate (market sentiment proxy)
 *
 * Fires as a "smartMoney" category signal.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class WhaleIntentStrategy implements Strategy {
  name = 'whaleIntent';
  description = 'Whale transfer intent classifier (operational vs directional, Nansen)';
  requiredData = ['nansenFlowData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const flow = ctx.nansenFlowData;
    if (!flow) {
      return {
        name: this.name,
        value: 0,
        confidence: 0,
        source: this.description,
        details: 'No Nansen flow data',
      };
    }

    const details: string[] = [];
    let value = 0;
    let confidence = 0.2;

    const netFlow = flow.netFlow24hUsd;
    const traderCount = flow.traderCount;
    const flowDirection = Math.sign(netFlow); // +1 buy, -1 sell

    // ── Intent classification ──

    // 1. Trader count analysis: many traders = consensus, few = single whale/operational
    const isConsensus = traderCount >= 5;
    const isSingleWhale = traderCount <= 2 && Math.abs(netFlow) > 500_000;

    // 2. Flow magnitude
    const flowMagnitude = Math.abs(netFlow);
    const isSignificant = flowMagnitude > 200_000; // >$200K
    const isLarge = flowMagnitude > 1_000_000; // >$1M

    if (!isSignificant) {
      return {
        name: this.name,
        value: 0,
        confidence: 0.1,
        source: this.description,
        details: `Flow too small ($${(flowMagnitude / 1000).toFixed(0)}K) for intent classification`,
      };
    }

    // 3. Cross-venue confirmation: does HL perp positioning agree?
    const hlPerps = ctx.nansenHlPerps;
    let crossVenueAgreement = false;
    let crossVenueDivergence = false;

    if (hlPerps && hlPerps.longRatio !== undefined) {
      const hlDirection = hlPerps.longRatio > 0.6 ? 1 : hlPerps.longRatio < 0.4 ? -1 : 0;
      if (hlDirection !== 0 && hlDirection === flowDirection) {
        crossVenueAgreement = true;
        details.push(`HL perps confirm: ${(hlPerps.longRatio * 100).toFixed(0)}% long`);
      } else if (hlDirection !== 0 && hlDirection === -flowDirection) {
        crossVenueDivergence = true;
        details.push(`HL perps DIVERGE: ${(hlPerps.longRatio * 100).toFixed(0)}% long vs on-chain ${flowDirection > 0 ? 'accumulation' : 'distribution'}`);
      }
    }

    // 4. Funding rate context: extreme funding = crowded trade
    const fundingRate = ctx.fundingRateData?.rate8h ?? 0;
    const isFundingExtreme = Math.abs(fundingRate) > 0.0005; // >0.05% per 8h

    // ── Score computation ──

    if (isConsensus && isLarge) {
      // Multiple smart wallets, large flow = strong directional intent
      value = flowDirection * 0.4;
      confidence = 0.6;
      const dir = netFlow > 0 ? 'accumulating' : 'distributing';
      details.push(`Consensus ${dir}: ${traderCount} smart wallets, $${(flowMagnitude / 1e6).toFixed(1)}M`);

      if (crossVenueAgreement) {
        value = flowDirection * 0.5;
        confidence = 0.75;
        details.push('Cross-venue confirmed');
      }
    } else if (isConsensus) {
      // Multiple wallets, moderate flow
      value = flowDirection * 0.25;
      confidence = 0.45;
      details.push(`Smart money consensus: ${traderCount} wallets, $${(flowMagnitude / 1000).toFixed(0)}K`);
    } else if (isSingleWhale) {
      // Single large transfer — could be operational (ETF AP, exchange rebalance)
      // Lower confidence unless cross-venue confirms
      if (crossVenueAgreement) {
        value = flowDirection * 0.3;
        confidence = 0.5;
        details.push(`Single whale $${(flowMagnitude / 1e6).toFixed(1)}M — cross-venue confirmed, likely directional`);
      } else {
        value = flowDirection * 0.15;
        confidence = 0.3;
        details.push(`Single whale $${(flowMagnitude / 1e6).toFixed(1)}M — may be operational (ETF/AP/rebalance)`);
      }
    }

    // Funding extreme warning: if funding is extreme in the same direction as flow,
    // the trade may be crowded (whale joining a crowded side = lower edge)
    if (isFundingExtreme && Math.sign(fundingRate) === flowDirection) {
      confidence *= 0.7; // reduce confidence
      details.push(`Crowded funding (${(fundingRate * 100).toFixed(3)}%) — whale joining crowded side`);
    }

    // Divergence penalty
    if (crossVenueDivergence) {
      confidence *= 0.5;
      details.push('WARNING: on-chain vs perps divergence — conflicting signals');
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.min(confidence, 1.0),
      source: this.description,
      details: details.join('; '),
    };
  }
}
