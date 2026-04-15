/**
 * HyperliquidPerpStrategy call builder.
 *
 * InitParams (Solidity): (address asset, uint256 depositAmount, uint256 minReturnAmount, uint32 perpAssetIndex, uint32 leverage, uint256 maxPositionSize, uint32 maxTradesPerDay)
 */

import type { Address, Hex } from "viem";
import { encodeAbiParameters, encodeFunctionData, maxUint256 } from "viem";
import { ERC20_ABI, BASE_STRATEGY_ABI, HYPERLIQUID_PERP_STRATEGY_ABI } from "../lib/abis.js";
import type { BatchCall } from "../lib/batch.js";

export function buildInitData(
  asset: Address,
  depositAmount: bigint,
  minReturnAmount: bigint,
  perpAssetIndex: number,
  leverage: number,
  maxPositionSize: bigint,
  maxTradesPerDay: number,
): Hex {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint32" },
      { type: "uint32" },
      { type: "uint256" },
      { type: "uint32" },
    ],
    [asset, depositAmount, minReturnAmount, perpAssetIndex, leverage, maxPositionSize, maxTradesPerDay],
  );
}

export function buildExecuteCalls(
  clone: Address,
  asset: Address,
  amount: bigint,
): BatchCall[] {
  // In dynamic-all mode (amount == 0) we approve maxUint256 up front and
  // revoke to 0 after execute() in the same atomic batch — the residual
  // allowance never persists beyond the tx.
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

/** Phase 2: sweep USDC back to vault after async HyperCore transfer completes. */
export function buildSweepToVaultCalls(clone: Address): BatchCall[] {
  return [
    {
      target: clone,
      data: encodeFunctionData({
        abi: HYPERLIQUID_PERP_STRATEGY_ABI,
        functionName: "sweepToVault",
      }),
      value: 0n,
    },
  ];
}
