/**
 * OnchainGridExecutor — calls HyperliquidGridStrategy.updateParams() on
 * HyperEVM via viem so grid orders execute against the strategy contract's
 * HyperCore account (which holds vault USDC parked there during execute()).
 *
 * Phase 2 of the grid executor — replaces the off-chain GridExecutor for
 * vault-funded mode. The off-chain executor is still useful for testing
 * with EOA capital.
 */

import chalk from 'chalk';
import { encodeAbiParameters, type Address, type Hex } from 'viem';
import { writeContractWithRetry } from '../lib/client.js';
import { gridCloid } from './cloid.js';
import { HYPERLIQUID_GRID_STRATEGY_ABI } from './strategy-abi.js';
import type { GridOrderPlan } from './manager.js';

export interface OnchainGridExecutorConfig {
  /** Address of the deployed HyperliquidGridStrategy clone. */
  strategyAddress: Address;
  /** Hyperliquid asset index per token (e.g. bitcoin → 3). */
  assetIndices: Record<string, number>;
  /** USDC limitPx scaling — HL uses 6 decimals for USD prices. */
  pxScale?: bigint;
  /** Token size scaling — HL uses 6 decimals for sizes by default. */
  szScale?: bigint;
}

const ACTION_PLACE_GRID = 1;
const ACTION_CANCEL_ALL = 2;
const ACTION_CANCEL_AND_PLACE = 3;

const GRID_ORDER_COMPONENTS = [
  { name: 'assetIndex', type: 'uint32' },
  { name: 'isBuy', type: 'bool' },
  { name: 'limitPx', type: 'uint64' },
  { name: 'sz', type: 'uint64' },
  { name: 'cloid', type: 'uint128' },
] as const;

export class OnchainGridExecutor {
  private cfg: OnchainGridExecutorConfig;
  /** Per-token nonce — increments on cancel/rebuild so prior CLOIDs go stale. */
  private nonces: Map<string, number> = new Map();

  constructor(cfg: OnchainGridExecutorConfig) {
    this.cfg = cfg;
  }

  /**
   * Execute the order plan: cancel stale orders for rebalanced tokens, then
   * place new orders. Uses ACTION_CANCEL_AND_PLACE for atomic rebalance, or
   * ACTION_PLACE_GRID for fresh placement.
   */
  async execute(plan: GridOrderPlan): Promise<{ placed: number; cancelled: number; txs: Hex[]; errors: string[] }> {
    const errors: string[] = [];
    const txs: Hex[] = [];
    let placed = 0;
    let cancelled = 0;

    // Group orders by token so we can use cancel-and-place atomically per asset
    const ordersByToken = new Map<string, typeof plan.ordersToPlace>();
    for (const o of plan.ordersToPlace) {
      if (!ordersByToken.has(o.token)) ordersByToken.set(o.token, []);
      ordersByToken.get(o.token)!.push(o);
    }

    const cancelSet = new Set(plan.assetsToCancel);

    // Tokens that need both cancel + place → ACTION_CANCEL_AND_PLACE
    // Tokens that only need cancel → ACTION_CANCEL_ALL
    // Tokens that only need place → ACTION_PLACE_GRID
    const allTokens = new Set([...ordersByToken.keys(), ...cancelSet]);

    for (const token of allTokens) {
      const assetIndex = this.cfg.assetIndices[token];
      if (assetIndex === undefined) {
        errors.push(`No asset index for ${token}`);
        continue;
      }

      const wantCancel = cancelSet.has(token);
      const orders = ordersByToken.get(token) ?? [];
      const wantPlace = orders.length > 0;

      try {
        if (wantCancel && wantPlace) {
          const tx = await this.cancelAndPlace(token, assetIndex, orders);
          txs.push(tx);
          cancelled += 1;
          placed += orders.length;
        } else if (wantCancel) {
          const tx = await this.cancelAll(token, assetIndex);
          txs.push(tx);
          cancelled += 1;
        } else if (wantPlace) {
          const tx = await this.placeGrid(token, assetIndex, orders);
          txs.push(tx);
          placed += orders.length;
        }
      } catch (e) {
        errors.push(`${token}: ${(e as Error).message}`);
      }
    }

    return { placed, cancelled, txs, errors };
  }

  private currentNonce(token: string): number {
    return this.nonces.get(token) ?? 0;
  }

  private bumpNonce(token: string): number {
    const next = this.currentNonce(token) + 1;
    this.nonces.set(token, next);
    return next;
  }

  private encodeGridOrders(
    assetIndex: number,
    orders: GridOrderPlan['ordersToPlace'],
    nonce: number,
  ): Array<{ assetIndex: number; isBuy: boolean; limitPx: bigint; sz: bigint; cloid: bigint }> {
    const pxScale = this.cfg.pxScale ?? 1_000_000n;
    const szScale = this.cfg.szScale ?? 1_000_000n;
    return orders.map((o, i) => ({
      assetIndex,
      isBuy: o.isBuy,
      limitPx: BigInt(Math.round(o.price * Number(pxScale))),
      sz: BigInt(Math.round(o.quantity * Number(szScale))),
      cloid: gridCloid(assetIndex, o.isBuy, i, nonce),
    }));
  }

  private async placeGrid(token: string, assetIndex: number, orders: GridOrderPlan['ordersToPlace']): Promise<Hex> {
    const nonce = this.bumpNonce(token);
    const encoded = this.encodeGridOrders(assetIndex, orders, nonce);
    const data = encodeAbiParameters(
      [
        { type: 'uint8' },
        { type: 'tuple[]', components: [...GRID_ORDER_COMPONENTS] },
      ],
      [ACTION_PLACE_GRID, encoded],
    );
    return this.send(data);
  }

  private async cancelAll(token: string, assetIndex: number): Promise<Hex> {
    // Cancel all CLOIDs from the CURRENT nonce (the live grid). After cancel,
    // bump nonce so subsequent placeGrid uses fresh CLOIDs.
    const cloids = this.cloidsForCurrentGrid(assetIndex, token);
    const data = encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint32' }, { type: 'uint128[]' }],
      [ACTION_CANCEL_ALL, assetIndex, cloids],
    );
    this.bumpNonce(token);
    return this.send(data);
  }

  private async cancelAndPlace(
    token: string,
    assetIndex: number,
    orders: GridOrderPlan['ordersToPlace'],
  ): Promise<Hex> {
    const oldCloids = this.cloidsForCurrentGrid(assetIndex, token);
    const newNonce = this.bumpNonce(token);
    const encoded = this.encodeGridOrders(assetIndex, orders, newNonce);
    const data = encodeAbiParameters(
      [
        { type: 'uint8' },
        { type: 'uint32' },
        { type: 'uint128[]' },
        { type: 'tuple[]', components: [...GRID_ORDER_COMPONENTS] },
      ],
      [ACTION_CANCEL_AND_PLACE, assetIndex, oldCloids, encoded],
    );
    return this.send(data);
  }

  /** Generate CLOIDs for the current grid (current nonce, both sides, up to 30 levels). */
  private cloidsForCurrentGrid(assetIndex: number, _token: string): bigint[] {
    const nonce = this.currentNonce(_token);
    if (nonce === 0) return []; // Nothing placed yet
    const cloids: bigint[] = [];
    // Conservative: up to 32 levels per side. Strategy contract caps at maxOrdersPerTick anyway.
    for (let i = 0; i < 32; i++) {
      cloids.push(gridCloid(assetIndex, true, i, nonce));
      cloids.push(gridCloid(assetIndex, false, i, nonce));
    }
    return cloids;
  }

  private async send(data: Hex): Promise<Hex> {
    const tx = await writeContractWithRetry({
      address: this.cfg.strategyAddress,
      abi: HYPERLIQUID_GRID_STRATEGY_ABI,
      functionName: 'updateParams',
      args: [data],
    });
    console.error(chalk.dim(`  [grid-onchain] tx ${tx.slice(0, 10)}...`));
    return tx;
  }
}
