/**
 * Types and helpers for BatchExecutor interaction.
 */

import type { Address, Hex } from "viem";
import { encodeFunctionData } from "viem";
import { BATCH_EXECUTOR_ABI } from "./abis.js";

export interface BatchCall {
  target: Address;
  data: Hex;
  value: bigint;
}

/**
 * Encode a batch of calls for the BatchExecutor contract.
 * Returns the ABI-encoded calldata for executeBatch(Call[]).
 * This is what gets passed as `data` to vault.executeStrategy().
 */
export function encodeBatchExecute(calls: BatchCall[]): Hex {
  return encodeFunctionData({
    abi: BATCH_EXECUTOR_ABI,
    functionName: "executeBatch",
    args: [
      calls.map((c) => ({
        target: c.target,
        data: c.data,
        value: c.value,
      })),
    ],
  });
}

/**
 * Format a batch for human-readable display (CLI output before simulation).
 */
export function formatBatch(calls: BatchCall[]): string {
  return calls
    .map((call, i) => {
      const selector = call.data.slice(0, 10);
      return `  ${i + 1}. ${call.target} :: ${selector}... (${call.value > 0n ? call.value + " wei" : "no value"})`;
    })
    .join("\n");
}
