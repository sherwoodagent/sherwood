/**
 * PortfolioStrategy call builder.
 *
 * InitParams (Solidity): (address asset, address swapAdapter, address chainlinkVerifier,
 *   address[] tokens, uint256[] weightsBps, uint256 totalAmount, uint256 maxSlippageBps,
 *   bytes[] swapExtraData)
 */

import type { Address, Hex } from "viem";
import { encodeAbiParameters, encodeFunctionData } from "viem";
import { ERC20_ABI, BASE_STRATEGY_ABI } from "../lib/abis.js";
import type { BatchCall } from "../lib/batch.js";

export interface BasketAllocation {
  token: Address;
  weightBps: number; // e.g. 4000 = 40%
  swapExtraData: Hex; // adapter-specific (fee tier, path, etc.)
}

export function buildInitData(
  asset: Address,
  swapAdapter: Address,
  chainlinkVerifier: Address,
  allocations: BasketAllocation[],
  totalAmount: bigint,
  maxSlippageBps: number,
): Hex {
  const tokens = allocations.map((a) => a.token);
  const weightsBps = allocations.map((a) => BigInt(a.weightBps));
  const swapExtraData = allocations.map((a) => a.swapExtraData);

  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address[]" },
      { type: "uint256[]" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes[]" },
    ],
    [
      asset,
      swapAdapter,
      chainlinkVerifier,
      tokens,
      weightsBps,
      totalAmount,
      BigInt(maxSlippageBps),
      swapExtraData,
    ],
  );
}

export function buildExecuteCalls(
  clone: Address,
  asset: Address,
  totalAmount: bigint,
): BatchCall[] {
  return [
    {
      target: asset,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [clone, totalAmount],
      }),
      value: 0n,
    },
    {
      target: clone,
      data: encodeFunctionData({
        abi: BASE_STRATEGY_ABI,
        functionName: "execute",
      }),
      value: 0n,
    },
  ];
}

export function buildSettleCalls(clone: Address): BatchCall[] {
  return [
    {
      target: clone,
      data: encodeFunctionData({
        abi: BASE_STRATEGY_ABI,
        functionName: "settle",
      }),
      value: 0n,
    },
  ];
}

export function buildUpdateParamsCalls(
  clone: Address,
  newWeightsBps: number[],
  newMaxSlippageBps: number,
  newSwapExtraData: Hex[],
): BatchCall[] {
  const data = encodeAbiParameters(
    [{ type: "uint256[]" }, { type: "uint256" }, { type: "bytes[]" }],
    [
      newWeightsBps.map((w) => BigInt(w)),
      BigInt(newMaxSlippageBps),
      newSwapExtraData,
    ],
  );

  return [
    {
      target: clone,
      data: encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "updateParams",
            inputs: [{ type: "bytes", name: "data" }],
            outputs: [],
            stateMutability: "nonpayable",
          },
        ],
        functionName: "updateParams",
        args: [data],
      }),
      value: 0n,
    },
  ];
}

// ── Rebalancing ──

import { PORTFOLIO_STRATEGY_ABI } from "../lib/abis.js";

/**
 * Encode calldata for the simple `rebalance()` call.
 * This is called directly by the proposer (not via vault batch).
 */
export function encodeRebalanceCalldata(): Hex {
  return encodeFunctionData({
    abi: PORTFOLIO_STRATEGY_ABI,
    functionName: "rebalance",
  });
}

/**
 * Encode calldata for `updateParams()` to change weights before rebalancing.
 */
export function encodeUpdateWeightsCalldata(
  newWeightsBps: number[],
  newMaxSlippageBps: number,
  newSwapExtraData: Hex[],
): Hex {
  const data = encodeAbiParameters(
    [{ type: "uint256[]" }, { type: "uint256" }, { type: "bytes[]" }],
    [
      newWeightsBps.map((w) => BigInt(w)),
      BigInt(newMaxSlippageBps),
      newSwapExtraData,
    ],
  );

  return encodeFunctionData({
    abi: PORTFOLIO_STRATEGY_ABI,
    functionName: "updateParams",
    args: [data],
  });
}
