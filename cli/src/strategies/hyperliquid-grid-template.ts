/**
 * HyperliquidGridStrategy call builder.
 *
 * InitParams (Solidity): (address asset, uint256 depositAmount, uint32 leverage, uint256 maxOrderSize, uint32 maxOrdersPerTick, uint32[] assetIndices)
 */

import type { Address, Hex } from "viem";
import { encodeAbiParameters, encodeFunctionData, maxUint256 } from "viem";
import { ERC20_ABI, BASE_STRATEGY_ABI } from "../lib/abis.js";
import type { BatchCall } from "../lib/batch.js";

export function buildInitData(
  asset: Address,
  depositAmount: bigint,
  leverage: number,
  maxOrderSize: bigint,
  maxOrdersPerTick: number,
  assetIndices: number[],
): Hex {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint32" },
      { type: "uint256" },
      { type: "uint32" },
      { type: "uint32[]" },
    ],
    [asset, depositAmount, leverage, maxOrderSize, maxOrdersPerTick, assetIndices],
  );
}

export function buildExecuteCalls(
  clone: Address,
  asset: Address,
  amount: bigint,
): BatchCall[] {
  const approveAmount = amount === 0n ? maxUint256 : amount;

  return [
    {
      target: asset,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [clone, approveAmount],
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
    {
      target: asset,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [clone, 0n],
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
