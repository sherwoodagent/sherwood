/**
 * MoonwellSupplyStrategy call builder.
 *
 * InitParams (Solidity): (address underlying, address mToken, uint256 supplyAmount, uint256 minRedeemAmount)
 */

import type { Address, Hex } from "viem";
import { encodeAbiParameters, encodeFunctionData } from "viem";
import { ERC20_ABI, BASE_STRATEGY_ABI } from "../lib/abis.js";
import type { BatchCall } from "../lib/batch.js";

export function buildInitData(
  underlying: Address,
  mToken: Address,
  supplyAmount: bigint,
  minRedeemAmount: bigint,
): Hex {
  return encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [underlying, mToken, supplyAmount, minRedeemAmount],
  );
}

export function buildExecuteCalls(
  clone: Address,
  underlying: Address,
  supplyAmount: bigint,
): BatchCall[] {
  return [
    {
      target: underlying,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [clone, supplyAmount],
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
