/**
 * GridExecutor — bridges GridManager output to real Hyperliquid orders.
 *
 * The strategy contract owns USDC on HyperCore margin. The keeper (proposer EOA)
 * calls strategy.updateParams() with batch order data each tick. The CLI uses
 * the HL SDK directly via hlPlaceLimitOrder / hlCancelAllOrders for the simpler
 * deployment path (off-chain orders against the keeper's HyperCore account).
 */

import chalk from 'chalk';
import { hlPlaceLimitOrder, hlCancelAllOrders, resolveHLCoin } from '../lib/hyperliquid-executor.js';
import type { GridOrderPlan } from './manager.js';

export interface GridExecutorConfig {
  /** Hyperliquid asset index per token (e.g. bitcoin → 3). */
  assetIndices: Record<string, number>;
}

export class GridExecutor {
  private cfg: GridExecutorConfig;

  constructor(cfg: GridExecutorConfig) {
    this.cfg = cfg;
  }

  /**
   * Execute the order plan against Hyperliquid.
   * Cancels stale orders for rebalanced tokens, then places new orders.
   */
  async execute(plan: GridOrderPlan): Promise<{ placed: number; cancelled: number; errors: string[] }> {
    const errors: string[] = [];
    let cancelled = 0;
    let placed = 0;

    for (const token of plan.assetsToCancel) {
      const coin = resolveHLCoin(token);
      if (!coin) {
        errors.push(`No HL ticker for ${token}`);
        continue;
      }
      try {
        await hlCancelAllOrders(coin);
        cancelled++;
        console.error(chalk.dim(`  [grid-exec] Cancelled all orders for ${coin}`));
      } catch (e) {
        errors.push(`Cancel ${coin} failed: ${(e as Error).message}`);
      }
    }

    for (const order of plan.ordersToPlace) {
      const coin = resolveHLCoin(order.token);
      if (!coin) {
        errors.push(`No HL ticker for ${order.token}`);
        continue;
      }
      try {
        const res = await hlPlaceLimitOrder(coin, order.isBuy, order.quantity, order.price);
        if (res.success) {
          placed++;
        } else {
          errors.push(`Place ${coin} ${order.isBuy ? 'buy' : 'sell'} @${order.price}: ${res.error}`);
        }
      } catch (e) {
        errors.push(`Place ${coin} threw: ${(e as Error).message}`);
      }
    }

    return { placed, cancelled, errors };
  }
}
