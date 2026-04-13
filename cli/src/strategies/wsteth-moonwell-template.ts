/**
 * WstETHMoonwellStrategy call builder.
 *
 * InitParams (Solidity struct):
 *   address weth, address wsteth, address mwsteth,
 *   address aeroRouter, address aeroFactory,
 *   uint256 supplyAmount, uint256 minWstethOut, uint256 minWethOut, uint256 deadlineOffset
 *   supplyAmount = 0 means use the vault's full WETH balance at execute time
 */

import type { Address, Hex } from "viem";
import { encodeAbiParameters, encodeFunctionData, maxUint256 } from "viem";
import { ERC20_ABI, BASE_STRATEGY_ABI } from "../lib/abis.js";
import type { BatchCall } from "../lib/batch.js";

export interface WstETHMoonwellInitParams {
  weth: Address;
  wsteth: Address;
  mwsteth: Address;
  aeroRouter: Address;
  aeroFactory: Address;
  supplyAmount: bigint;
  minWstethOut: bigint;
  minWethOut: bigint;
  deadlineOffset: bigint;
}

const INIT_PARAMS_TYPES = [
  {
    type: "tuple" as const,
    components: [
      { name: "weth", type: "address" as const },
      { name: "wsteth", type: "address" as const },
      { name: "mwsteth", type: "address" as const },
      { name: "aeroRouter", type: "address" as const },
      { name: "aeroFactory", type: "address" as const },
      { name: "supplyAmount", type: "uint256" as const },
      { name: "minWstethOut", type: "uint256" as const },
      { name: "minWethOut", type: "uint256" as const },
      { name: "deadlineOffset", type: "uint256" as const },
    ],
  },
] as const;

export function buildInitData(params: WstETHMoonwellInitParams): Hex {
  return encodeAbiParameters(INIT_PARAMS_TYPES, [params]);
}

export function buildExecuteCalls(
  clone: Address,
  weth: Address,
  supplyAmount: bigint,
): BatchCall[] {
  const approveAmount = supplyAmount === 0n ? maxUint256 : supplyAmount;

  return [
    {
      target: weth,
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
