import { describe, it, expect, vi } from 'vitest';
import { OnchainGridExecutor } from './onchain-executor.js';
import { gridCloid } from './cloid.js';

const sentTxs: any[] = [];

vi.mock('../lib/client.js', () => ({
  writeContractWithRetry: vi.fn(async (params) => {
    sentTxs.push(params);
    return '0xdeadbeef' as const;
  }),
}));

describe('OnchainGridExecutor', () => {
  it('encodes ACTION_PLACE_GRID for new orders', async () => {
    sentTxs.length = 0;
    const exec = new OnchainGridExecutor({
      strategyAddress: '0x0000000000000000000000000000000000000001',
      assetIndices: { bitcoin: 3 },
    });
    const result = await exec.execute({
      ordersToPlace: [{ token: 'bitcoin', isBuy: true, price: 76000, quantity: 0.01 }],
      assetsToCancel: [],
      needsRebalance: false,
    });
    expect(result.placed).toBe(1);
    expect(result.cancelled).toBe(0);
    expect(result.errors).toEqual([]);
    expect(sentTxs.length).toBe(1);
    expect(sentTxs[0].functionName).toBe('updateParams');
  });

  it('encodes ACTION_CANCEL_AND_PLACE when token is in both lists', async () => {
    sentTxs.length = 0;
    const exec = new OnchainGridExecutor({
      strategyAddress: '0x0000000000000000000000000000000000000001',
      assetIndices: { bitcoin: 3 },
    });
    // Place once to bump nonce
    await exec.execute({
      ordersToPlace: [{ token: 'bitcoin', isBuy: true, price: 76000, quantity: 0.01 }],
      assetsToCancel: [],
      needsRebalance: false,
    });
    sentTxs.length = 0;
    // Now rebalance
    const result = await exec.execute({
      ordersToPlace: [{ token: 'bitcoin', isBuy: true, price: 77000, quantity: 0.01 }],
      assetsToCancel: ['bitcoin'],
      needsRebalance: true,
    });
    expect(result.placed).toBe(1);
    expect(result.cancelled).toBe(1);
    expect(sentTxs.length).toBe(1); // single atomic tx
  });

  it('records error for unknown token', async () => {
    const exec = new OnchainGridExecutor({
      strategyAddress: '0x0000000000000000000000000000000000000001',
      assetIndices: {},
    });
    const result = await exec.execute({
      ordersToPlace: [{ token: 'unknown', isBuy: true, price: 100, quantity: 1 }],
      assetsToCancel: [],
      needsRebalance: false,
    });
    expect(result.placed).toBe(0);
    expect(result.errors.length).toBe(1);
  });
});

describe('gridCloid', () => {
  it('produces deterministic 16-byte uint128', () => {
    const c1 = gridCloid(3, true, 0, 1);
    const c2 = gridCloid(3, true, 0, 1);
    expect(c1).toBe(c2);
    // Different nonce → different cloid
    const c3 = gridCloid(3, true, 0, 2);
    expect(c3).not.toBe(c1);
    // Fits in uint128
    expect(c1).toBeLessThan(2n ** 128n);
  });
});
