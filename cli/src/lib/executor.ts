/**
 * BatchExecutor contract wrapper.
 *
 * Note: executeBatch() has onlyVault modifier — CLI never calls it directly.
 * Execution goes through vault.executeStrategy(). This module is for
 * simulation and target management.
 */

import type { Address, Hex } from "viem";
import { encodeFunctionData, decodeFunctionResult } from "viem";
import { base } from "viem/chains";
import { getPublicClient, getWalletClient, getAccount } from "./client.js";
import { BATCH_EXECUTOR_ABI } from "./abis.js";
import type { BatchCall } from "./batch.js";

export interface SimulationResult {
  success: boolean;
  returnData: Hex;
}

function getExecutorAddress(): Address {
  const addr = process.env.BATCH_EXECUTOR_ADDRESS;
  if (!addr) {
    throw new Error("BATCH_EXECUTOR_ADDRESS env var is required");
  }
  return addr as Address;
}

/**
 * Simulate a batch via eth_call (no state committed).
 * simulateBatch is NOT a view function — must use raw eth_call.
 */
export async function simulate(calls: BatchCall[]): Promise<SimulationResult[]> {
  const client = getPublicClient();
  const executorAddress = getExecutorAddress();

  const calldata = encodeFunctionData({
    abi: BATCH_EXECUTOR_ABI,
    functionName: "simulateBatch",
    args: [
      calls.map((c) => ({
        target: c.target,
        data: c.data,
        value: c.value,
      })),
    ],
  });

  const { data } = await client.call({
    to: executorAddress,
    data: calldata,
  });

  if (!data) {
    throw new Error("simulateBatch returned no data");
  }

  const decoded = decodeFunctionResult({
    abi: BATCH_EXECUTOR_ABI,
    functionName: "simulateBatch",
    data,
  });

  return (decoded as readonly { success: boolean; returnData: Hex }[]).map((r) => ({
    success: r.success,
    returnData: r.returnData,
  }));
}

/**
 * Add a single target to the executor allowlist.
 */
export async function addTarget(target: Address): Promise<Hex> {
  const client = getWalletClient();
  return client.writeContract({
    account: getAccount(),
    chain: base,
    address: getExecutorAddress(),
    abi: BATCH_EXECUTOR_ABI,
    functionName: "addTarget",
    args: [target],
  });
}

/**
 * Add multiple targets to the executor allowlist.
 */
export async function addTargets(targets: Address[]): Promise<Hex> {
  const client = getWalletClient();
  return client.writeContract({
    account: getAccount(),
    chain: base,
    address: getExecutorAddress(),
    abi: BATCH_EXECUTOR_ABI,
    functionName: "addTargets",
    args: [targets],
  });
}

/**
 * Check if a target is in the allowlist.
 */
export async function isAllowedTarget(target: Address): Promise<boolean> {
  const client = getPublicClient();
  return client.readContract({
    address: getExecutorAddress(),
    abi: BATCH_EXECUTOR_ABI,
    functionName: "isAllowedTarget",
    args: [target],
  }) as Promise<boolean>;
}

/**
 * Get all allowed targets.
 */
export async function getAllowedTargets(): Promise<Address[]> {
  const client = getPublicClient();
  return client.readContract({
    address: getExecutorAddress(),
    abi: BATCH_EXECUTOR_ABI,
    functionName: "getAllowedTargets",
  }) as Promise<Address[]>;
}
