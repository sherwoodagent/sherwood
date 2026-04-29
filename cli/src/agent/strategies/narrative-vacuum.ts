/**
 * Narrative-Vacuum Whale Signal — detects when whale flow spikes but
 * social/news volume is quiet ("the market is positioning before the
 * narrative catches up").
 *
 * Signal: WhaleFlowZ × (1 - SocialVolumeZ)
 *   - High whale flow + low social chatter = smart money moving silently → follow
 *   - High whale flow + high social chatter = crowd already knows → no edge
 *   - Low whale flow + any chatter = nothing happening
 *
 * Data sources:
 *   - Nansen smart-money netflow (whale positioning)
 *   - SocialData/CryptoCompare news count (narrative proxy)
 *
 * Fires as an "onchain" category signal.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class NarrativeVacuumStrategy implements Strategy {
  name = 'narrativeVacuum';
  description = 'Whale flow divergence from social narrative (Nansen + social data)';
  requiredData = ['nansenFlowData', 'socialData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const flow = ctx.nansenFlowData;
    const social = ctx.socialData;

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
    let confidence = 0.3;

    // ── Whale flow strength ──
    // netFlow24hUsd: positive = smart money accumulating, negative = distributing
    const netFlow = flow.netFlow24hUsd;
    const traderCount = flow.traderCount;

    // Normalize flow: $1M+ is a strong signal
    const flowStrength = Math.min(1, Math.abs(netFlow) / 2_000_000); // 0-1 scale
    const flowDirection = Math.sign(netFlow); // +1 accumulating, -1 distributing

    if (flowStrength < 0.1) {
      // Minimal whale activity — no signal
      return {
        name: this.name,
        value: 0,
        confidence: 0.1,
        source: this.description,
        details: `Low whale flow ($${(netFlow / 1000).toFixed(0)}K, ${traderCount} traders) — no edge`,
      };
    }

    // ── Social narrative intensity ──
    // newsCount24h: 0 = silence, 1-3 = quiet, 5+ = moderate, 10+ = loud
    const newsCount = social?.newsCount24h ?? 0;

    // Social intensity score: 0 = total silence, 1 = very loud
    const socialIntensity = Math.min(1, newsCount / 10);

    // ── Narrative vacuum = high flow × low chatter ──
    // vacuum: 1 = whale flow with zero chatter (strongest signal)
    // vacuum: 0 = whale flow with heavy chatter (crowd already knows)
    const vacuum = 1 - socialIntensity;
    const vacuumScore = flowStrength * vacuum;

    if (vacuumScore > 0.3) {
      // Strong narrative vacuum — follow the whales
      value = flowDirection * (0.2 + vacuumScore * 0.3); // ±0.2 to ±0.5
      confidence = 0.5 + vacuumScore * 0.25; // 0.5 to 0.75

      const dir = netFlow > 0 ? 'accumulating' : 'distributing';
      details.push(
        `Whale ${dir} $${(Math.abs(netFlow) / 1_000_000).toFixed(1)}M (${traderCount} traders) ` +
        `with only ${newsCount} news articles — narrative vacuum (score ${vacuumScore.toFixed(2)})`
      );
    } else if (flowStrength > 0.3 && socialIntensity > 0.5) {
      // Whale flow exists but crowd already talking — no vacuum edge
      details.push(
        `Whale flow $${(Math.abs(netFlow) / 1_000_000).toFixed(1)}M but ${newsCount} articles — ` +
        `narrative already priced in`
      );
      confidence = 0.2;
    } else {
      details.push(
        `Moderate flow $${(Math.abs(netFlow) / 1000).toFixed(0)}K, ${newsCount} articles — ` +
        `insufficient vacuum`
      );
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
