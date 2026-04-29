/**
 * BTC Network Health Strategy
 *
 * Uses Blockchain.com network data (via Fincept) to gauge Bitcoin network
 * health: transaction count, miner revenue, and mempool demand.
 * Only fires for bitcoin — returns zero-confidence for other tokens.
 */

import type { Signal } from '../scoring.js';
import type { Strategy, StrategyContext } from './types.js';
import { clamp } from '../utils.js';

export class BtcNetworkHealthStrategy implements Strategy {
  name = 'btcNetworkHealth';
  description = 'Analyzes BTC network health — tx count, miner revenue, mempool demand';
  requiredData = ['btcNetworkData'];

  async analyze(ctx: StrategyContext): Promise<Signal> {
    if (ctx.tokenId !== 'bitcoin') {
      return {
        name: this.name,
        value: 0,
        confidence: 0,
        source: 'BTC Network Health',
        details: 'Not bitcoin — skipped',
      };
    }

    if (!ctx.btcNetworkData) {
      return {
        name: this.name,
        value: 0,
        confidence: 0.1,
        source: 'BTC Network Health',
        details: 'No BTC network data available',
      };
    }

    const { transactionCount, minerRevenueBtc, mempoolSize } = ctx.btcNetworkData;
    const details: string[] = [];
    let value = 0;

    // Transaction count signals
    if (transactionCount > 300_000) {
      value += 0.2;
      details.push(`active network (${(transactionCount / 1000).toFixed(0)}k txs)`);
    } else if (transactionCount < 200_000) {
      value -= 0.1;
      details.push(`low activity (${(transactionCount / 1000).toFixed(0)}k txs)`);
    }

    // Miner revenue signals
    if (minerRevenueBtc > 1000) {
      value += 0.15;
      details.push(`healthy miners (${minerRevenueBtc.toFixed(0)} BTC revenue)`);
    }

    // Mempool demand signals
    if (mempoolSize > 100_000) {
      value += 0.1;
      details.push(`high demand (${(mempoolSize / 1000).toFixed(0)}k mempool)`);
    }

    const confidence = details.length > 0 ? 0.5 : 0.2;

    return {
      name: this.name,
      value: clamp(value),
      confidence,
      source: 'BTC Network Health',
      details: details.length > 0 ? details.join('; ') : 'Network metrics within normal range',
    };
  }
}
