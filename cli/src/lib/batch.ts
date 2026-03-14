/**
 * Types and helpers for batch call construction.
 *
 * Calls go directly to vault.executeBatch() — no separate executor contract.
 */

import type { Address, Hex } from "viem";

export interface BatchCall {
  target: Address;
  data: Hex;
  value: bigint;
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
