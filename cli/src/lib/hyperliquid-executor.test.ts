import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFile = vi.fn();
vi.mock('node:child_process', () => ({ execFile }));

beforeEach(() => {
  vi.resetModules();
  execFile.mockReset();
});

describe('hlGetMeta', () => {
  it('parses universe and computes pxDecimals = 6 - szDecimals', async () => {
    execFile.mockImplementationOnce((_node, _args, _opts, cb) => {
      const meta = JSON.stringify([
        { name: 'BTC', szDecimals: 5 },
        { name: 'ETH', szDecimals: 4 },
        { name: 'SOL', szDecimals: 2 },
      ]);
      cb(null, meta, '');
    });
    const { hlGetMeta } = await import('./hyperliquid-executor.js');
    const m = await hlGetMeta();
    expect(m.get('BTC')).toEqual({ name: 'BTC', szDecimals: 5, pxDecimals: 1 });
    expect(m.get('ETH')).toEqual({ name: 'ETH', szDecimals: 4, pxDecimals: 2 });
    expect(m.get('SOL')).toEqual({ name: 'SOL', szDecimals: 2, pxDecimals: 4 });
  });
});
