/**
 * OnchainGridExecutor — calls HyperliquidGridStrategy.updateParams() on
 * HyperEVM via viem so grid orders execute against the strategy contract's
 * HyperCore account (which holds vault USDC).
 *
 * Persists per-token nonces + placed-CLOID tracking to disk so a restart
 * can correctly cancel the orders left on-chain by the prior process.
 */

import chalk from 'chalk';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { encodeAbiParameters, parseUnits, type Address, type Hex } from 'viem';
import { getPublicClient, writeContractWithRetry } from '../lib/client.js';
import { hlGetMeta, resolveHLCoin, type HLAssetMeta } from '../lib/hyperliquid-executor.js';
import { gridCloid } from './cloid.js';
import { HYPERLIQUID_GRID_STRATEGY_ABI } from './strategy-abi.js';
import type { GridOrderPlan } from './manager.js';

const ONCHAIN_STATE_PATH = join(homedir(), '.sherwood', 'grid', 'onchain-state.json');
const UINT64_MAX = 18446744073709551615n;

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

interface EncodedOrder {
  assetIndex: number;
  isBuy: boolean;
  limitPx: bigint;
  sz: bigint;
  cloid: bigint;
}

const ACTION_PLACE_GRID = 1;
const ACTION_CANCEL_ALL = 2;
const ACTION_CANCEL_AND_PLACE = 3;

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk size must be > 0 (got ${size})`);
  if (arr.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
  private busy = false;
  /** On-chain `maxOrdersPerTick`; cached at load(). Used to chunk batches so
   *  the strategy never reverts with TooManyOrders(actual, max). */
  private maxOrdersPerTick: number | null = null;

  constructor(cfg: OnchainGridExecutorConfig) {
    this.cfg = cfg;
  }

  /** Read the strategy's per-call order cap and cache it. */
  private async fetchMaxOrdersPerTick(): Promise<number> {
    if (this.maxOrdersPerTick !== null) return this.maxOrdersPerTick;
    const pub = getPublicClient();
    const value = await pub.readContract({
      address: this.cfg.strategyAddress,
      abi: HYPERLIQUID_GRID_STRATEGY_ABI,
      functionName: 'maxOrdersPerTick',
    });
    this.maxOrdersPerTick = Number(value);
    return this.maxOrdersPerTick;
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
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // First run — fine
      } else {
        // Corrupt JSON or other read error — start fresh. On-chain state is the
        // source of truth; at worst we orphan one cycle of orders until HL
        // expires them via TIF.
        console.error(
          chalk.yellow(
            `  [grid-onchain] Failed to load state (${(e as Error).message}) — starting fresh. Existing on-chain orders may be orphaned.`,
          ),
        );
      }
    }
    if (!this.meta) this.meta = await hlGetMeta();
    await this.fetchMaxOrdersPerTick();
  }

  /**
   * Atomic save: write to .tmp, then POSIX-rename. A crash mid-write leaves
   * either the old file intact or the new file fully written — never a
   * partial JSON that would crash load() on restart.
   */
  private async save(): Promise<void> {
    const state: PersistedState = {
      nonces: Object.fromEntries(this.nonces),
      placedCloids: Object.fromEntries(
        [...this.placedCloids].map(([tok, cloids]) => [tok, cloids.map((c) => c.toString())]),
      ),
    };
    await mkdir(dirname(ONCHAIN_STATE_PATH), { recursive: true });
    const tmp = ONCHAIN_STATE_PATH + '.tmp';
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, ONCHAIN_STATE_PATH);
  }

  /**
   * Execute the order plan: cancel stale orders for rebalanced tokens, then
   * place new orders. Each (token) is one tx. Persists state after each tx
   * so a crash mid-execution still leaves a recoverable on-disk record.
   *
   * Concurrency-guarded: a second concurrent call returns immediately rather
   * than racing tx submission against another in-flight execute().
   */
  async execute(plan: GridOrderPlan): Promise<{ placed: number; cancelled: number; txs: Hex[]; errors: string[] }> {
    if (this.busy) {
      return { placed: 0, cancelled: 0, txs: [], errors: ['execute() already in flight — skipping'] };
    }
    this.busy = true;
    try {
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
            const txArr = await this.cancelAndPlace(token, assetIndex, orders, meta);
            txs.push(...txArr);
            cancelled += 1;
            placed += orders.length;
          } else if (wantCancel) {
            const tx = await this.cancelAll(token, assetIndex);
            txs.push(tx);
            cancelled += 1;
          } else if (wantPlace) {
            const txArr = await this.placeGrid(token, assetIndex, orders, meta);
            txs.push(...txArr);
            placed += orders.length;
          }
          await this.save();
        } catch (e) {
          errors.push(`${token}: ${(e as Error).message}`);
        }
      }

      return { placed, cancelled, txs, errors };
    } finally {
      this.busy = false;
    }
  }

  private currentNonce(token: string): number {
    return this.nonces.get(token) ?? 0;
  }

  private bumpNonce(token: string): number {
    const next = this.currentNonce(token) + 1;
    this.nonces.set(token, next);
    return next;
  }

  /**
   * Pure encoding — does NOT mutate placedCloids. Caller commits CLOIDs
   * only after the on-chain tx confirms successfully.
   *
   * Uses viem's `parseUnits` for decimal scaling instead of float math so
   * high-szDecimals tokens (BTC=5, ETH=4) keep full precision on small sizes.
   */
  private encodeOrders(
    assetIndex: number,
    orders: GridOrderPlan['ordersToPlace'],
    meta: HLAssetMeta,
    nonce: number,
  ): { encoded: EncodedOrder[]; cloids: bigint[] } {
    const cloids: bigint[] = [];
    const encoded = orders.map((o, i) => {
      const cloid = gridCloid(this.cfg.strategyAddress, assetIndex, o.isBuy, i, nonce);
      cloids.push(cloid);
      // parseUnits uses string scaling — no float-rounding precision loss.
      const limitPx = parseUnits(o.price.toFixed(meta.pxDecimals), meta.pxDecimals);
      const sz = parseUnits(o.quantity.toFixed(meta.szDecimals), meta.szDecimals);
      // Defensive uint64 bound check — parseUnits returns uint256 but the
      // strategy contract reads uint64.
      if (limitPx > UINT64_MAX || sz > UINT64_MAX) {
        throw new Error(
          `Order exceeds uint64: token=${o.token} px=${limitPx} sz=${sz}`,
        );
      }
      return { assetIndex, isBuy: o.isBuy, limitPx, sz, cloid };
    });
    return { encoded, cloids };
  }

  /**
   * Place orders, chunking into batches of ≤ maxOrdersPerTick per tx.
   * Each chunk uses its own nonce so CLOIDs stay unique across chunks.
   * placedCloids is committed once after the last chunk lands; if any
   * chunk reverts, the partial cloids stay tracked via the per-chunk save.
   */
  private async placeGrid(
    token: string,
    assetIndex: number,
    orders: GridOrderPlan['ordersToPlace'],
    meta: HLAssetMeta,
  ): Promise<Hex[]> {
    const max = await this.fetchMaxOrdersPerTick();
    const chunks = chunkArray(orders, max);
    const txs: Hex[] = [];
    const allCloids: bigint[] = [...(this.placedCloids.get(token) ?? [])];
    for (const chunk of chunks) {
      const nonce = this.bumpNonce(token);
      const { encoded, cloids } = this.encodeOrders(assetIndex, chunk, meta, nonce);
      const data = encodeAbiParameters(
        [{ type: 'uint8' }, { type: 'tuple[]', components: [...GRID_ORDER_COMPONENTS] }],
        [ACTION_PLACE_GRID, encoded],
      );
      const tx = await this.send(data); // throws if reverts
      txs.push(tx);
      allCloids.push(...cloids);
      this.placedCloids.set(token, allCloids); // commit incrementally so cancel-on-restart sees what landed
      await this.save();
    }
    return txs;
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
    const tx = await this.send(data); // throws if reverts
    this.placedCloids.set(token, []); // commit only on success
    this.bumpNonce(token);
    return tx;
  }

  /**
   * Atomic cancel-old + place-new on rebalance. When `orders` exceeds
   * maxOrdersPerTick, the first chunk uses ACTION_CANCEL_AND_PLACE (so the
   * old orders are cleared in the same tx as the first wave of new orders);
   * subsequent chunks use ACTION_PLACE_GRID. Atomicity holds for chunk #1;
   * after that there's a brief window where some new orders are live before
   * the rest are placed — acceptable for a 60s rebuild cycle.
   */
  private async cancelAndPlace(
    token: string,
    assetIndex: number,
    orders: GridOrderPlan['ordersToPlace'],
    meta: HLAssetMeta,
  ): Promise<Hex[]> {
    const max = await this.fetchMaxOrdersPerTick();
    const chunks = chunkArray(orders, max);
    const oldCloids = this.placedCloids.get(token) ?? [];
    const txs: Hex[] = [];
    const allNewCloids: bigint[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const newNonce = this.bumpNonce(token);
      const { encoded, cloids } = this.encodeOrders(assetIndex, chunk, meta, newNonce);
      let data: Hex;
      if (i === 0) {
        // First chunk swaps old → new in one tx.
        data = encodeAbiParameters(
          [
            { type: 'uint8' },
            { type: 'uint32' },
            { type: 'uint128[]' },
            { type: 'tuple[]', components: [...GRID_ORDER_COMPONENTS] },
          ],
          [ACTION_CANCEL_AND_PLACE, assetIndex, oldCloids, encoded],
        );
      } else {
        data = encodeAbiParameters(
          [{ type: 'uint8' }, { type: 'tuple[]', components: [...GRID_ORDER_COMPONENTS] }],
          [ACTION_PLACE_GRID, encoded],
        );
      }
      const tx = await this.send(data); // throws if reverts
      txs.push(tx);
      allNewCloids.push(...cloids);
      // After chunk #0 the old cloids are already cancelled on-chain — record
      // only the new cloids that have landed so far.
      this.placedCloids.set(token, [...allNewCloids]);
      await this.save();
    }
    return txs;
  }

  /**
   * Submit and wait for receipt. Throwing here surfaces to the per-token
   * try/catch in execute(), recording the error and skipping the save() so
   * placedCloids never reflects orders that didn't land.
   */
  private async send(data: Hex): Promise<Hex> {
    const tx = await writeContractWithRetry({
      address: this.cfg.strategyAddress,
      abi: HYPERLIQUID_GRID_STRATEGY_ABI,
      functionName: 'updateParams',
      args: [data],
    });
    const pub = getPublicClient();
    const receipt = await pub.waitForTransactionReceipt({ hash: tx, timeout: 30_000 });
    if (receipt.status !== 'success') {
      throw new Error(`Tx ${tx} reverted on-chain`);
    }
    console.error(chalk.dim(`  [grid-onchain] tx ${tx.slice(0, 10)}... confirmed`));
    return tx;
  }
}
