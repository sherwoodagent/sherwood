/**
 * Token Unlock Frontrun Strategy
 * Parses Messari data for upcoming token unlocks and signals bearish pressure.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

interface UnlockEvent {
  percentOfSupply: number;
  daysUntil: number;
  type: 'team' | 'investor' | 'community' | 'ecosystem' | 'unknown';
}

function parseUnlocks(messariData: Record<string, unknown>): UnlockEvent[] {
  const unlocks: UnlockEvent[] = [];

  // Try to extract unlock data from Messari's token profile
  const profile = messariData.profile as Record<string, unknown> | undefined;
  const tokenomics = (profile?.economics ?? profile?.tokenomics ?? messariData.tokenomics) as Record<string, unknown> | undefined;
  const schedule = (tokenomics?.vesting_schedule ?? tokenomics?.unlock_schedule ?? messariData.unlock_schedule) as Array<Record<string, unknown>> | undefined;

  if (!schedule || !Array.isArray(schedule)) return unlocks;

  const now = Date.now();

  for (const entry of schedule) {
    const unlockDate = entry.date ?? entry.unlock_date ?? entry.timestamp;
    if (!unlockDate) continue;

    const unlockTime = typeof unlockDate === 'number' ? unlockDate : new Date(String(unlockDate)).getTime();
    const daysUntil = (unlockTime - now) / (1000 * 60 * 60 * 24);

    // Only care about future unlocks within 30 days
    if (daysUntil < 0 || daysUntil > 30) continue;

    const percentOfSupply = Number(entry.percent ?? entry.percent_of_supply ?? entry.amount_pct ?? 0);
    const typeRaw = String(entry.type ?? entry.category ?? entry.recipient ?? 'unknown').toLowerCase();

    let type: UnlockEvent['type'] = 'unknown';
    if (typeRaw.includes('team') || typeRaw.includes('founder')) type = 'team';
    else if (typeRaw.includes('investor') || typeRaw.includes('vc') || typeRaw.includes('seed') || typeRaw.includes('private')) type = 'investor';
    else if (typeRaw.includes('community') || typeRaw.includes('airdrop')) type = 'community';
    else if (typeRaw.includes('ecosystem') || typeRaw.includes('treasury')) type = 'ecosystem';

    unlocks.push({ percentOfSupply, daysUntil, type });
  }

  return unlocks;
}

export class TokenUnlockStrategy implements Strategy {
  name = 'tokenUnlock';
  description = 'Detects upcoming token unlocks and signals potential selling pressure';
  requiredData = ['messariData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    // Try Messari data first (x402), then fall back to DefiLlama unlock estimates
    if (!ctx.messariData && !ctx.unlockData) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.1,
        source: 'Token Unlock Frontrun',
        details: 'No unlock data available',
      };
    }

    // If we have DefiLlama-based unlock estimates but no Messari data, use those
    if (!ctx.messariData && ctx.unlockData) {
      return this.analyzeFromUnlockData(ctx.unlockData);
    }

    const unlocks = parseUnlocks(ctx.messariData as Record<string, unknown>);

    if (unlocks.length === 0) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.3,
        source: 'Token Unlock Frontrun',
        details: 'No upcoming token unlocks detected within 30 days',
      };
    }

    let value = 0;
    let confidence = 0.5;
    const details: string[] = [];

    for (const unlock of unlocks) {
      let signal = 0;

      // Large unlock (>5% supply) within 7 days: strong bearish
      if (unlock.percentOfSupply > 5 && unlock.daysUntil <= 7) {
        signal = -(0.6 + Math.min((unlock.percentOfSupply - 5) / 15, 0.4)); // -0.6 to -1.0
        confidence = 0.8;
      }
      // Large unlock (>2% supply) within 14 days: bearish
      else if (unlock.percentOfSupply > 2 && unlock.daysUntil <= 14) {
        signal = -(0.3 + Math.min((unlock.percentOfSupply - 2) / 10, 0.5)); // -0.3 to -0.8
        confidence = Math.max(confidence, 0.6);
      }
      // Smaller unlock: mild bearish
      else if (unlock.percentOfSupply > 1) {
        signal = -0.2;
      }

      // VC/team unlock multiplier (more selling pressure expected)
      if (unlock.type === 'team' || unlock.type === 'investor') {
        signal = clamp(signal * 1.5);
        details.push(
          `${unlock.percentOfSupply.toFixed(1)}% supply unlocking in ${Math.ceil(unlock.daysUntil)} days (type: ${unlock.type}) — elevated sell pressure`,
        );
      } else {
        details.push(
          `${unlock.percentOfSupply.toFixed(1)}% supply unlocking in ${Math.ceil(unlock.daysUntil)} days (type: ${unlock.type})`,
        );
      }

      // Take the most bearish signal
      if (signal < value) value = signal;
    }

    return {
      name: this.name,
      value: clamp(value),
      confidence: Math.min(confidence, 1.0),
      source: 'Token Unlock Frontrun',
      details: details.join('; '),
    };
  }

  /** Analyze from DefiLlama FDV-based unlock estimates (free fallback) */
  private analyzeFromUnlockData(data: NonNullable<StrategyContext['unlockData']>): Signal {
    if (data.upcomingUnlocks.length === 0 || data.totalUpcomingPercent < 0.5) {
      return {
        name: this.name,
        value: 0.0,
        confidence: 0.2,
        source: 'Token Unlock Frontrun',
        details: 'No significant upcoming unlocks detected',
      };
    }

    // Score based on weekly unlock pressure
    let value = 0;
    const pct = data.totalUpcomingPercent;
    if (pct > 5) value = -0.6;
    else if (pct > 2) value = -0.4;
    else if (pct > 1) value = -0.2;

    const details = data.upcomingUnlocks.map((u) => u.description).join('; ');

    return {
      name: this.name,
      value: clamp(value),
      confidence: 0.4, // lower confidence since these are estimates
      source: 'Token Unlock Frontrun',
      details: details || `~${pct.toFixed(1)}% estimated weekly vesting`,
    };
  }
}
