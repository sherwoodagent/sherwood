/**
 * Minimal ABI for HyperliquidGridStrategy.updateParams.
 * Just the proposer-callable entrypoint — execute()/settle() are vault-only.
 */
export const HYPERLIQUID_GRID_STRATEGY_ABI = [
  {
    type: 'function',
    name: 'updateParams',
    inputs: [{ name: 'data', type: 'bytes' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;
