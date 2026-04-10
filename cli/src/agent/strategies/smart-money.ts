/**
 * Smart Money Convergence Strategy
 * Analyzes Nansen smart-money netflow data to detect institutional accumulation/distribution.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class SmartMoneyStrategy implements Strategy {
  name = 'smartMoney';
  description = 'Analyzes Nansen smart-money netflow to detect institutional accumulation or distribution';
  requiredData = ['nansenData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const details: string[] = [];

    if (!ctx.nansenData) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.1,
        source: 'Smart Money Convergence',
        details: 'No Nansen smart-money data available',
      };
    }

    const data = ctx.nansenData as Record<string, unknown>;
    const flows = data.flows as Array<Record<string, unknown>> | undefined;

    if (!flows || flows.length === 0) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.1,
        source: 'Smart Money Convergence',
        details: 'No smart-money flow data found',
      };
    }

    // Calculate net flow across all tracked wallets
    const netflow = flows.reduce(
      (sum, f) => sum + (Number(f.netflow ?? f.net_flow ?? 0)),
      0,
    );

    // Count wallets accumulating vs distributing
    const accumulating = flows.filter(
      f => (Number(f.netflow ?? f.net_flow ?? 0)) < 0, // negative = leaving exchanges = buying
    ).length;
    const distributing = flows.length - accumulating;

    // Convergence: multiple wallets moving same direction
    const convergenceRatio = Math.max(accumulating, distributing) / flows.length;
    const isConverging = convergenceRatio > 0.7;

    let value = 0;
    let confidence = 0.5;

    if (netflow < 0) {
      // Negative net flow = leaving exchanges = smart money buying
      const magnitude = Math.min(Math.abs(netflow) / 1_000_000, 1.0); // normalize
      value = 0.5 + magnitude * 0.5; // +0.5 to +1.0
      details.push(`Smart money buying: net outflow ${Math.abs(netflow).toFixed(0)} tokens`);
      confidence = 0.6;
    } else if (netflow > 0) {
      // Positive net flow = entering exchanges = smart money selling
      const magnitude = Math.min(Math.abs(netflow) / 1_000_000, 1.0);
      value = -(0.5 + magnitude * 0.5); // -0.5 to -1.0
      details.push(`Smart money selling: net inflow ${netflow.toFixed(0)} tokens`);
      confidence = 0.6;
    } else {
      details.push('Smart money neutral: no significant flow');
    }

    // Convergence bonus
    if (isConverging && value !== 0) {
      const bonus = value > 0 ? 0.15 : -0.15;
      value = clamp(value + bonus);
      details.push(`${accumulating}/${flows.length} wallets accumulating (convergence signal)`);
      confidence += 0.15;
    } else {
      details.push(`Mixed signals: ${accumulating} accumulating, ${distributing} distributing`);
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.min(confidence, 1.0),
      source: 'Smart Money Convergence',
      details: details.join('; '),
    };
  }
}
