import { describe, it, expect, vi } from 'vitest';
import { GridExecutor } from './executor.js';

vi.mock('../lib/hyperliquid-executor.js', () => ({
  hlPlaceLimitOrder: vi.fn(async () => ({ success: true, orderId: '123' })),
  hlCancelAllOrders: vi.fn(async () => 'ok'),
  resolveHLCoin: (token: string) => ({ bitcoin: 'BTC', ethereum: 'ETH' } as Record<string, string>)[token],
}));

describe('GridExecutor', () => {
  it('places orders and cancels for rebalanced assets', async () => {
    const exec = new GridExecutor({ assetIndices: { bitcoin: 3 } });
    const result = await exec.execute({
      ordersToPlace: [{ token: 'bitcoin', isBuy: true, price: 76000, quantity: 0.01 }],
      assetsToCancel: ['bitcoin'],
      needsRebalance: true,
    });
    expect(result.placed).toBe(1);
    expect(result.cancelled).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('records error for unknown token', async () => {
    const exec = new GridExecutor({ assetIndices: {} });
    const result = await exec.execute({
      ordersToPlace: [{ token: 'unknown', isBuy: true, price: 100, quantity: 1 }],
      assetsToCancel: [],
      needsRebalance: false,
    });
    expect(result.placed).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('No HL ticker for unknown');
  });
});
