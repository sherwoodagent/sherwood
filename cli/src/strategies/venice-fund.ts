/**
 * Venice Fund Strategy — swap vault profits to VVV → stake → distribute sVVV to agents.
 *
 * The vault's deposit token is swapped to VVV via Uniswap V3 multi-hop routing
 * (asset → WETH → VVV). If the asset IS WETH, a single-hop swap is used instead.
 *
 * The staking contract's stake(recipient, amount) mints sVVV directly to each agent's
 * operator wallet — no separate transfer step needed.
 *
 * sVVV holders can then self-provision Venice API keys for private inference.
 */

import type { Address, Hex } from "viem";
import { encodeFunctionData, parseUnits } from "viem";
import type { BatchCall } from "../lib/batch.js";
import { TOKENS, UNISWAP, VENICE } from "../lib/addresses.js";

// ── Strategy Config ──

export interface VeniceFundConfig {
  /** Deposit token amount to convert (human-readable, e.g. "500") */
  amount: string;
  /** Fee tier for asset → WETH hop (ignored if asset = WETH) */
  fee1: number;
  /** Fee tier for WETH → VVV hop */
  fee2: number;
  /** Max slippage in basis points (e.g. 100 = 1%) */
  slippageBps: number;
}

// ── ABIs (minimal, for encoding batch calls) ──

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const SWAP_ROUTER_EXACT_INPUT_SINGLE_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const SWAP_ROUTER_EXACT_INPUT_ABI = [
  {
    name: "exactInput",
    type: "function",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const STAKING_ABI = [
  {
    name: "stake",
    type: "function",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

// ── Batch Builders ──

/**
 * Build the Venice fund batch.
 *
 * @param config - Strategy parameters
 * @param vaultAddress - Vault contract address (delegatecall identity)
 * @param agents - Agent operator EOA addresses to receive sVVV
 * @param assetAddress - Vault's deposit token address
 * @param assetDecimals - Deposit token decimals
 * @param minVVV - Minimum VVV output (post-slippage from Uniswap quote)
 * @param swapPath - Encoded Uniswap V3 path for multi-hop (null if single-hop)
 */
export function buildFundBatch(
  config: VeniceFundConfig,
  vaultAddress: Address,
  agents: Address[],
  assetAddress: Address,
  assetDecimals: number,
  minVVV: bigint,
  swapPath: Hex | null,
): BatchCall[] {
  const assetAmount = parseUnits(config.amount, assetDecimals);
  const isWeth = assetAddress.toLowerCase() === TOKENS().WETH.toLowerCase();
  const calls: BatchCall[] = [];

  // 1. Approve SwapRouter to spend vault asset
  calls.push({
    target: assetAddress,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [UNISWAP().SWAP_ROUTER, assetAmount],
    }),
    value: 0n,
  });

  // 2. Swap asset → VVV
  if (isWeth) {
    // Single-hop: WETH → VVV
    calls.push({
      target: UNISWAP().SWAP_ROUTER,
      data: encodeFunctionData({
        abi: SWAP_ROUTER_EXACT_INPUT_SINGLE_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: TOKENS().WETH,
            tokenOut: VENICE().VVV,
            fee: config.fee2,
            recipient: vaultAddress,
            amountIn: assetAmount,
            amountOutMinimum: minVVV,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
      value: 0n,
    });
  } else {
    // Multi-hop: asset → WETH → VVV
    calls.push({
      target: UNISWAP().SWAP_ROUTER,
      data: encodeFunctionData({
        abi: SWAP_ROUTER_EXACT_INPUT_ABI,
        functionName: "exactInput",
        args: [
          {
            path: swapPath!,
            recipient: vaultAddress,
            amountIn: assetAmount,
            amountOutMinimum: minVVV,
          },
        ],
      }),
      value: 0n,
    });
  }

  // 3. Approve staking contract to pull VVV
  calls.push({
    target: VENICE().VVV,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [VENICE().STAKING, minVVV],
    }),
    value: 0n,
  });

  // 4. Stake VVV directly to each agent's operator wallet
  const perAgent = minVVV / BigInt(agents.length);
  for (const agent of agents) {
    calls.push({
      target: VENICE().STAKING,
      data: encodeFunctionData({
        abi: STAKING_ABI,
        functionName: "stake",
        args: [agent, perAgent],
      }),
      value: 0n,
    });
  }

  return calls;
}
