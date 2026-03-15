/**
 * Allowance Disburse Strategy — swap vault profits to USDC and distribute to agents.
 *
 * If the vault's deposit token is already USDC, transfers directly to each agent.
 * Otherwise, swaps asset → USDC via Uniswap V3 (single-hop or multi-hop via WETH),
 * then distributes USDC equally to each agent's operator wallet.
 *
 * Agents use USDC for operational expenses: gas, x402 API payments, etc.
 */

import type { Address, Hex } from "viem";
import { encodeFunctionData, parseUnits } from "viem";
import type { BatchCall } from "../lib/batch.js";
import { TOKENS, UNISWAP } from "../lib/addresses.js";

// ── Strategy Config ──

export interface AllowanceDisbursConfig {
  /** Deposit token amount to convert & distribute (human-readable, e.g. "500") */
  amount: string;
  /** Fee tier for asset → USDC swap (ignored if asset = USDC) */
  fee: number;
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
  {
    name: "transfer",
    type: "function",
    inputs: [
      { name: "to", type: "address" },
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

// ── Batch Builder ──

/**
 * Build the allowance disburse batch.
 *
 * @param config - Strategy parameters
 * @param vaultAddress - Vault contract address (delegatecall identity)
 * @param agents - Agent operator EOA addresses to receive USDC
 * @param assetAddress - Vault's deposit token address
 * @param assetDecimals - Deposit token decimals
 * @param minUsdc - Minimum USDC output (post-slippage), or raw amount if asset IS USDC
 * @param swapPath - Encoded Uniswap V3 path for multi-hop (null if single-hop or no swap)
 */
export function buildDisburseBatch(
  config: AllowanceDisbursConfig,
  vaultAddress: Address,
  agents: Address[],
  assetAddress: Address,
  assetDecimals: number,
  minUsdc: bigint,
  swapPath: Hex | null,
): BatchCall[] {
  const assetAmount = parseUnits(config.amount, assetDecimals);
  const isUsdc = assetAddress.toLowerCase() === TOKENS().USDC.toLowerCase();
  const isWeth = assetAddress.toLowerCase() === TOKENS().WETH.toLowerCase();
  const calls: BatchCall[] = [];

  if (!isUsdc) {
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

    // 2. Swap asset → USDC
    if (isWeth) {
      // Single-hop: WETH → USDC
      calls.push({
        target: UNISWAP().SWAP_ROUTER,
        data: encodeFunctionData({
          abi: SWAP_ROUTER_EXACT_INPUT_SINGLE_ABI,
          functionName: "exactInputSingle",
          args: [
            {
              tokenIn: TOKENS().WETH,
              tokenOut: TOKENS().USDC,
              fee: config.fee,
              recipient: vaultAddress,
              amountIn: assetAmount,
              amountOutMinimum: minUsdc,
              sqrtPriceLimitX96: 0n,
            },
          ],
        }),
        value: 0n,
      });
    } else {
      // Multi-hop: asset → WETH → USDC
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
              amountOutMinimum: minUsdc,
            },
          ],
        }),
        value: 0n,
      });
    }
  }

  // 3. Transfer USDC to each agent equally
  const perAgent = minUsdc / BigInt(agents.length);
  for (const agent of agents) {
    calls.push({
      target: TOKENS().USDC,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [agent, perAgent],
      }),
      value: 0n,
    });
  }

  return calls;
}
