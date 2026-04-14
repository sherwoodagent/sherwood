"use client";

/**
 * GasEstimate — pre-flight gas-cost preview for an upcoming write call.
 *
 * Calls publicClient.estimateContractGas + getGasPrice to compute a native
 * cost. Renders nothing while resolving; renders "—" on failure. Surfaces
 * a "high gas" warning when the cost exceeds 5% of an optional comparison
 * amount (used for deposit modals: cost > 5% of deposit is a yellow flag).
 *
 * Skipped on chains where gas is negligible (Base, Base Sepolia, HyperEVM)
 * — those still render but as info, not a warning.
 */

import { useEffect, useState } from "react";
import { useAccount, usePublicClient } from "wagmi";
import { type Abi, type Address, formatEther } from "viem";

interface Props {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  chainId: number;
  /** Optional native-currency value attached to the call. */
  value?: bigint;
  /** Optional comparison amount in WEI (e.g. deposit amount converted via
   *  asset-to-eth oracle, or just `value` for ETH transfers). When the
   *  estimated cost exceeds 5% of this, surface a "high gas" warning.
   *  No callers wire this today — left in place for follow-up that adds an
   *  asset → native price conversion to deposit/withdraw modals. */
  compareAmountWei?: bigint;
  /** Symbol of the chain's native token (defaults "ETH"). */
  nativeSymbol?: string;
}

interface Estimate {
  gasUnits: bigint;
  gasPrice: bigint;
  costWei: bigint;
}

/** Coerce an arg value to a stable string for dep-array memoization.
 *  Standard JSON.stringify throws on bigints, which viem uses heavily. */
function stableArg(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") {
    try {
      return JSON.stringify(v, (_, val) =>
        typeof val === "bigint" ? val.toString() : val,
      );
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export function GasEstimate({
  address,
  abi,
  functionName,
  args,
  chainId,
  value,
  compareAmountWei,
  nativeSymbol = "ETH",
}: Props) {
  const { address: account } = useAccount();
  const client = usePublicClient({ chainId });
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState(false);

  // Stable arg key for the effect deps. Plain JSON.stringify can't handle
  // bigints (most viem args contain them) and would throw a TypeError at
  // runtime when the dep list evaluates. We stringify each arg manually
  // with bigint-aware coercion.
  const argsKey = (args ?? []).map(stableArg).join("|");

  useEffect(() => {
    if (!client || !account) return;
    let cancelled = false;

    (async () => {
      try {
        setError(false);
        const [gasUnits, gasPrice] = await Promise.all([
          client.estimateContractGas({
            address,
            abi,
            functionName,
            args,
            account,
            value,
          }),
          client.getGasPrice(),
        ]);
        if (cancelled) return;
        // Pad estimate by 15% — wallets typically pad too, and we want the
        // displayed number to be on the conservative side.
        const padded = (gasUnits * 115n) / 100n;
        setEstimate({
          gasUnits: padded,
          gasPrice,
          costWei: padded * gasPrice,
        });
      } catch {
        if (!cancelled) setError(true);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Re-estimate on argument changes via the bigint-safe argsKey above.
  }, [client, account, address, abi, functionName, argsKey, value, chainId]);

  if (!account) return null;

  if (error) {
    return (
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--color-fg-secondary)",
          marginTop: "0.5rem",
        }}
      >
        Gas estimate unavailable.
      </div>
    );
  }

  if (!estimate) {
    return (
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--color-fg-secondary)",
          marginTop: "0.5rem",
        }}
      >
        Estimating gas…
      </div>
    );
  }

  const costNative = parseFloat(formatEther(estimate.costWei));
  const display = costNative < 0.0001 ? "<0.0001" : costNative.toFixed(5);
  const isHighGas =
    compareAmountWei && compareAmountWei > 0n
      ? estimate.costWei * 20n > compareAmountWei // cost > 5%
      : false;

  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: isHighGas ? "#eab308" : "var(--color-fg-secondary)",
        marginTop: "0.5rem",
        display: "flex",
        gap: "0.5rem",
        alignItems: "center",
      }}
      title={isHighGas ? "Gas exceeds 5% of the transaction amount" : undefined}
    >
      <span style={{ opacity: 0.65, letterSpacing: "0.1em" }}>EST. GAS</span>
      <span>
        ~{display} {nativeSymbol}
      </span>
      {isHighGas && (
        <span
          style={{
            color: "#eab308",
            border: "1px solid rgba(234, 179, 8, 0.4)",
            padding: "1px 5px",
            fontSize: 9,
            letterSpacing: "0.18em",
          }}
        >
          HIGH
        </span>
      )}
    </div>
  );
}
