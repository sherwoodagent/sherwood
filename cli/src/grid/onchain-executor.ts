/**
 * OnchainGridExecutor — calls HyperliquidGridStrategy.updateParams() on
 * HyperEVM via viem so grid orders execute against the strategy contract's
 * HyperCore account (which holds vault USDC).
 *
 * Persists per-token nonces + placed-CLOID tracking to disk so a restart
 * can correctly cancel the orders left on-chain by the prior process.
 */

import chalk from 'chalk';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { encodeAbiParameters, type Address, type Hex } from 'viem';
import { writeContractWithRetry } from '../lib/client.js';
import { hlGetMeta, resolveHLCoin, type HLAssetMeta } from '../lib/hyperliquid-executor.js';
import { gridCloid } from './cloid.js';
import { HYPERLIQUID_GRID_STRATEGY_ABI } from './strategy-abi.js';
import type { GridOrderPlan } from './manager.js';

const ONCHAIN_STATE_PATH = join(homedir(), '.sherwood', 'grid', 'onchain-state.json');

export interface OnchainGridExecutorConfig {
  strategyAddress: Address;
  /** Hyperliquid asset index per token (e.g. bitcoin → 3). */
  assetIndices: Record<string, number>;
}

interface PersistedState {
  /** Per-token nonce — increments on cancel/rebuild. */
  nonces: Record<string, number>;
  /** Per-token CLOIDs of the orders currently live on HyperCore. Stored as decimal strings (BigInt). */
  placedCloids: Record<string, string[]>;
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
  private nonces: Map<string, number> = new Map();
  private placedCloids: Map<string, bigint[]> = new Map();
  private meta: Map<string, HLAssetMeta> | null = null;

  constructor(cfg: OnchainGridExecutorConfig) {
    this.cfg = cfg;
  }

  /** Load persisted state. Call once before the first execute(). */
  async load(): Promise<void> {
    try {
      const raw = await readFile(ONCHAIN_STATE_PATH, 'utf-8');
      const state = JSON.parse(raw) as PersistedState;
      for (const [tok, n] of Object.entries(state.nonces)) this.nonces.set(tok, n);
      for (const [tok, cloids] of Object.entries(state.placedCloids)) {
        this.placedCloids.set(tok, cloids.map((s) => BigInt(s)));
      }
      console.error(chalk.dim(`  [grid-onchain] Loaded state: ${this.nonces.size} tokens`));
    } catch (e) {
      // First run — state file doesn't exist
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (!this.meta) this.meta = await hlGetMeta();
  }

  private async save(): Promise<void> {
    const state: PersistedState = {
      nonces: Object.fromEntries(this.nonces),
      placedCloids: Object.fromEntries(
        [...this.placedCloids].map(([tok, cloids]) => [tok, cloids.map((c) => c.toString())]),
      ),
    };
    await mkdir(dirname(ONCHAIN_STATE_PATH), { recursive: true });
    await writeFile(ONCHAIN_STATE_PATH, JSON.stringify(state, null, 2));
  }

  /**
   * Execute the order plan: cancel stale orders for rebalanced tokens, then
   * place new orders. Each (token) is one tx. Persists state after each tx
   * so a crash mid-execution still leaves a recoverable on-disk record.
   */
  async execute(plan: GridOrderPlan): Promise<{ placed: number; cancelled: number; txs: Hex[]; errors: string[] }> {
    if (!this.meta) await this.load();

    const errors: string[] = [];
    const txs: Hex[] = [];
    let placed = 0;
    let cancelled = 0;

    const ordersByToken = new Map<string, GridOrderPlan['ordersToPlace']>();
    for (const o of plan.ordersToPlace) {
      if (!ordersByToken.has(o.token)) ordersByToken.set(o.token, []);
      ordersByToken.get(o.token)!.push(o);
    }
    const cancelSet = new Set(plan.assetsToCancel);
    const allTokens = new Set([...ordersByToken.keys(), ...cancelSet]);

    for (const token of allTokens) {
      const assetIndex = this.cfg.assetIndices[token];
      if (assetIndex === undefined) {
        errors.push(`No asset index for ${token}`);
        continue;
      }
      const coin = resolveHLCoin(token);
      if (!coin) {
        errors.push(`No HL ticker for ${token}`);
        continue;
      }
      const meta = this.meta!.get(coin);
      if (!meta) {
        errors.push(`No HL meta for ${coin} (run \`sherwood grid status\` to refresh)`);
        continue;
      }

      const wantCancel = cancelSet.has(token);
      const orders = ordersByToken.get(token) ?? [];
      const wantPlace = orders.length > 0;

      try {
        if (wantCancel && wantPlace) {
          const tx = await this.cancelAndPlace(token, assetIndex, orders, meta);
          txs.push(tx);
          cancelled += 1;
          placed += orders.length;
        } else if (wantCancel) {
          const tx = await this.cancelAll(token, assetIndex);
          txs.push(tx);
          cancelled += 1;
        } else if (wantPlace) {
          const tx = await this.placeGrid(token, assetIndex, orders, meta);
          txs.push(tx);
          placed += orders.length;
        }
        await this.save();
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

  /** Encode orders with per-asset decimal scaling and store CLOIDs for later cancel. */
  private encodeAndTrack(
    token: string,
    assetIndex: number,
    orders: GridOrderPlan['ordersToPlace'],
    meta: HLAssetMeta,
    nonce: number,
  ): Array<{ assetIndex: number; isBuy: boolean; limitPx: bigint; sz: bigint; cloid: bigint }> {
    const pxScale = 10n ** BigInt(meta.pxDecimals);
    const szScale = 10n ** BigInt(meta.szDecimals);
    const cloids: bigint[] = [];
    const encoded = orders.map((o, i) => {
      const cloid = gridCloid(assetIndex, o.isBuy, i, nonce);
      cloids.push(cloid);
      return {
        assetIndex,
        isBuy: o.isBuy,
        limitPx: BigInt(Math.round(o.price * Number(pxScale))),
        sz: BigInt(Math.round(o.quantity * Number(szScale))),
        cloid,
      };
    });
    this.placedCloids.set(token, cloids);
    return encoded;
  }

  private async placeGrid(
    token: string,
    assetIndex: number,
    orders: GridOrderPlan['ordersToPlace'],
    meta: HLAssetMeta,
  ): Promise<Hex> {
    const nonce = this.bumpNonce(token);
    const encoded = this.encodeAndTrack(token, assetIndex, orders, meta, nonce);
    const data = encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'tuple[]', components: [...GRID_ORDER_COMPONENTS] }],
      [ACTION_PLACE_GRID, encoded],
    );
    return this.send(data);
  }

  private async cancelAll(token: string, assetIndex: number): Promise<Hex> {
    const cloids = this.placedCloids.get(token) ?? [];
    if (cloids.length === 0) {
      // Nothing tracked — nothing to cancel. Still bump nonce for consistency.
      this.bumpNonce(token);
      return '0x' as Hex;
    }
    const data = encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'uint32' }, { type: 'uint128[]' }],
      [ACTION_CANCEL_ALL, assetIndex, cloids],
    );
    this.placedCloids.set(token, []);
    this.bumpNonce(token);
    return this.send(data);
  }

  private async cancelAndPlace(
    token: string,
    assetIndex: number,
    orders: GridOrderPlan['ordersToPlace'],
    meta: HLAssetMeta,
  ): Promise<Hex> {
    const oldCloids = this.placedCloids.get(token) ?? [];
    const newNonce = this.bumpNonce(token);
    const encoded = this.encodeAndTrack(token, assetIndex, orders, meta, newNonce);
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
