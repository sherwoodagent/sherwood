/**
 * VeniceInferenceStrategy call builder.
 *
 * InitParams (Solidity struct):
 *   address asset, address weth, address vvv, address sVVV,
 *   address aeroRouter, address aeroFactory, address agent,
 *   uint256 assetAmount, uint256 minVVV, uint256 deadlineOffset, bool singleHop
 */

import type { Address, Hex } from "viem";
import { encodeAbiParameters, encodeFunctionData } from "viem";
import { ERC20_ABI, BASE_STRATEGY_ABI } from "../lib/abis.js";
import type { BatchCall } from "../lib/batch.js";

export interface VeniceInferenceInitParams {
  asset: Address;
  weth: Address;
  vvv: Address;
  sVVV: Address;
  aeroRouter: Address;
  aeroFactory: Address;
  agent: Address;
  assetAmount: bigint;
  minVVV: bigint;
  deadlineOffset: bigint;
  singleHop: boolean;
}

const INIT_PARAMS_TYPES = [
  {
    type: "tuple" as const,
    components: [
      { name: "asset", type: "address" as const },
      { name: "weth", type: "address" as const },
      { name: "vvv", type: "address" as const },
      { name: "sVVV", type: "address" as const },
      { name: "aeroRouter", type: "address" as const },
      { name: "aeroFactory", type: "address" as const },
      { name: "agent", type: "address" as const },
      { name: "assetAmount", type: "uint256" as const },
      { name: "minVVV", type: "uint256" as const },
      { name: "deadlineOffset", type: "uint256" as const },
      { name: "singleHop", type: "bool" as const },
    ],
  },
] as const;

export function buildInitData(params: VeniceInferenceInitParams): Hex {
  return encodeAbiParameters(INIT_PARAMS_TYPES, [params]);
}

export function buildExecuteCalls(
  clone: Address,
  asset: Address,
  assetAmount: bigint,
): BatchCall[] {
  return [
    {
      target: asset,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [clone, assetAmount],
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
