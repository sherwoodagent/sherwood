import { describe, it, expect, vi, beforeEach } from 'vitest';

const sentTxs: any[] = [];

vi.mock('../lib/client.js', () => ({
  writeContractWithRetry: vi.fn(async (params) => {
    sentTxs.push(params);
    return '0xdeadbeef' as const;
  }),
  getPublicClient: vi.fn(() => ({
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' as const })),
  })),
}));

// Mock hlGetMeta so executor doesn't shell out
vi.mock('../lib/hyperliquid-executor.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/hyperliquid-executor.js')>('../lib/hyperliquid-executor.js');
  return {
    ...actual,
    hlGetMeta: vi.fn(async () =>
      new Map([
        ['BTC', { name: 'BTC', szDecimals: 5, pxDecimals: 1 }],
        ['ETH', { name: 'ETH', szDecimals: 4, pxDecimals: 2 }],
      ]),
    ),
    resolveHLCoin: (token: string) => ({ bitcoin: 'BTC', ethereum: 'ETH' } as Record<string, string>)[token],
  };
});

// Mock fs to avoid touching disk. `rename` is required by the atomic-save path.
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
}));

beforeEach(() => {
  sentTxs.length = 0;
});

describe('OnchainGridExecutor', () => {
  it('encodes ACTION_PLACE_GRID for new orders with per-asset scaling', async () => {
    const { OnchainGridExecutor } = await import('./onchain-executor.js');
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
    const { OnchainGridExecutor } = await import('./onchain-executor.js');
    const exec = new OnchainGridExecutor({
      strategyAddress: '0x0000000000000000000000000000000000000001',
      assetIndices: { bitcoin: 3 },
    });
    await exec.execute({
      ordersToPlace: [{ token: 'bitcoin', isBuy: true, price: 76000, quantity: 0.01 }],
      assetsToCancel: [],
      needsRebalance: false,
    });
    sentTxs.length = 0;
    const result = await exec.execute({
      ordersToPlace: [{ token: 'bitcoin', isBuy: true, price: 77000, quantity: 0.01 }],
      assetsToCancel: ['bitcoin'],
      needsRebalance: true,
    });
    expect(result.placed).toBe(1);
    expect(result.cancelled).toBe(1);
    expect(sentTxs.length).toBe(1);
  });

  it('records error for unknown token (no asset index)', async () => {
    const { OnchainGridExecutor } = await import('./onchain-executor.js');
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

  it('records error when HL meta missing for asset', async () => {
    const { OnchainGridExecutor } = await import('./onchain-executor.js');
    const exec = new OnchainGridExecutor({
      strategyAddress: '0x0000000000000000000000000000000000000001',
      assetIndices: { solana: 5 },
    });
    const result = await exec.execute({
      // SOL not in mocked meta map
      ordersToPlace: [{ token: 'solana', isBuy: true, price: 85, quantity: 1 }],
      assetsToCancel: [],
      needsRebalance: false,
    });
    expect(result.errors.some((e) => e.includes('No HL') || e.includes('No HL ticker'))).toBe(true);
  });
});
