/**
 * Glassnode On-Chain Strategy
 *
 * Uses Glassnode on-chain metrics (NVT ratio, SOPR, active address growth)
 * to generate trading signals. Only available for BTC and ETH.
 *
 * Signal logic:
 * - NVT < 30: bullish (+0.4), NVT > 80: bearish (-0.4)
 * - SOPR < 1.0: capitulation / contrarian buy (+0.3), SOPR > 1.05: profit taking (-0.2)
 * - Active addr growth > 5%: bullish (+0.3), < -5%: bearish (-0.3)
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class GlassnodeOnChainStrategy implements Strategy {
  name = 'glassnodeOnChain';
  description = 'Analyzes Glassnode on-chain metrics (NVT, SOPR, active addresses) for BTC/ETH';
  requiredData = ['glassnodeData'] as string[];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    const data = ctx.glassnodeData;

    if (!data) {
      return {
        name: this.name,
        value: 0,
        confidence: 0,
        source: 'Glassnode On-Chain',
        details: 'No Glassnode data available',
      };
    }

    const details: string[] = [];
    let value = 0;

    // --- NVT Ratio ---
    const { nvtRatio } = data;
    if (nvtRatio > 0) {
      if (nvtRatio < 30) {
        const scaled = 0.4 * ((30 - nvtRatio) / 30);
        value += scaled;
        details.push(`NVT ${nvtRatio.toFixed(1)} < 30: bullish (+${scaled.toFixed(2)})`);
      } else if (nvtRatio > 80) {
        const scaled = 0.4 * Math.min((nvtRatio - 80) / 80, 1);
        value -= scaled;
        details.push(`NVT ${nvtRatio.toFixed(1)} > 80: bearish (-${scaled.toFixed(2)})`);
      } else {
        details.push(`NVT ${nvtRatio.toFixed(1)}: neutral`);
      }
    }

    // --- SOPR ---
    const { sopr } = data;
    if (sopr > 0) {
      if (sopr < 1.0) {
        const scaled = 0.3 * Math.min((1.0 - sopr) / 0.1, 1);
        value += scaled;
        details.push(`SOPR ${sopr.toFixed(3)} < 1.0: capitulation, contrarian buy (+${scaled.toFixed(2)})`);
      } else if (sopr > 1.05) {
        const scaled = 0.2 * Math.min((sopr - 1.05) / 0.1, 1);
        value -= scaled;
        details.push(`SOPR ${sopr.toFixed(3)} > 1.05: profit taking (-${scaled.toFixed(2)})`);
      } else {
        details.push(`SOPR ${sopr.toFixed(3)}: neutral`);
      }
    }

    // --- Active Address Growth ---
    const { activeAddressesGrowth } = data;
    if (activeAddressesGrowth > 0.05) {
      const scaled = 0.3 * Math.min(activeAddressesGrowth / 0.2, 1);
      value += scaled;
      details.push(`Addr growth ${(activeAddressesGrowth * 100).toFixed(1)}% > 5%: bullish (+${scaled.toFixed(2)})`);
    } else if (activeAddressesGrowth < -0.05) {
      const scaled = 0.3 * Math.min(Math.abs(activeAddressesGrowth) / 0.2, 1);
      value -= scaled;
      details.push(`Addr growth ${(activeAddressesGrowth * 100).toFixed(1)}% < -5%: bearish (-${scaled.toFixed(2)})`);
    } else {
      details.push(`Addr growth ${(activeAddressesGrowth * 100).toFixed(1)}%: neutral`);
    }

    // Confidence based on how many metrics contributed
    const metricsAvailable = [nvtRatio > 0, sopr > 0, true].filter(Boolean).length;
    const confidence = Math.min(0.3 + metricsAvailable * 0.15, 0.8);

    return {
      name: this.name,
      value: clamp(value),
      confidence,
      source: 'Glassnode On-Chain',
      details: details.join('; '),
    };
  }
}
