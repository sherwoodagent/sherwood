/**
 * Minimal ABI for HyperliquidGridStrategy: updateParams (proposer-callable
 * entrypoint) + maxOrdersPerTick getter for read-side chunking.
 */
export const HYPERLIQUID_GRID_STRATEGY_ABI = [
  {
    type: 'function',
    name: 'updateParams',
    inputs: [{ name: 'data', type: 'bytes' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'maxOrdersPerTick',
    inputs: [],
    outputs: [{ type: 'uint32' }],
    stateMutability: 'view',
  },
] as const;
