/**
 * AerodromeLPStrategy call builder.
 *
 * InitParams (Solidity struct):
 *   address tokenA, address tokenB, bool stable,
 *   address factory, address router, address gauge, address lpToken,
 *   uint256 amountADesired, uint256 amountBDesired,
 *   uint256 amountAMin, uint256 amountBMin,
 *   uint256 minAmountAOut, uint256 minAmountBOut
 */

import type { Address, Hex } from "viem";
import { encodeAbiParameters, encodeFunctionData } from "viem";
import { ERC20_ABI, BASE_STRATEGY_ABI } from "../lib/abis.js";
import type { BatchCall } from "../lib/batch.js";

export interface AerodromeLPInitParams {
  tokenA: Address;
  tokenB: Address;
  stable: boolean;
  factory: Address;
  router: Address;
  gauge: Address;
  lpToken: Address;
  amountADesired: bigint;
  amountBDesired: bigint;
  amountAMin: bigint;
  amountBMin: bigint;
  minAmountAOut: bigint;
  minAmountBOut: bigint;
}

const INIT_PARAMS_TYPES = [
  {
    type: "tuple" as const,
    components: [
      { name: "tokenA", type: "address" as const },
      { name: "tokenB", type: "address" as const },
      { name: "stable", type: "bool" as const },
      { name: "factory", type: "address" as const },
      { name: "router", type: "address" as const },
      { name: "gauge", type: "address" as const },
      { name: "lpToken", type: "address" as const },
      { name: "amountADesired", type: "uint256" as const },
      { name: "amountBDesired", type: "uint256" as const },
      { name: "amountAMin", type: "uint256" as const },
      { name: "amountBMin", type: "uint256" as const },
      { name: "minAmountAOut", type: "uint256" as const },
      { name: "minAmountBOut", type: "uint256" as const },
    ],
  },
] as const;

export function buildInitData(params: AerodromeLPInitParams): Hex {
  return encodeAbiParameters(INIT_PARAMS_TYPES, [params]);
}

export function buildExecuteCalls(
  clone: Address,
  tokenA: Address,
  amountA: bigint,
  tokenB: Address,
  amountB: bigint,
): BatchCall[] {
  return [
    {
      target: tokenA,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [clone, amountA],
      }),
      value: 0n,
    },
    {
      target: tokenB,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [clone, amountB],
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
