"use client";

/**
 * ActivePositionValue — live read of IStrategy.positionValue() on the
 * clone deployed by this proposal.
 *
 * Two-step fetch:
 *   1. `getExecuteCalls(proposalId)` on the governor → the strategy clone
 *      is the non-asset target in the call batch (call 0 is typically
 *      `asset.approve(clone, amount)`, call 1 is `clone.execute(...)`).
 *   2. `positionValue()` on that clone, refreshed every 30s.
 *
 * If the clone was deployed before PR #218 it doesn't implement the view
 * and the call reverts — the component degrades to a placeholder rather
 * than crashing.  Likewise if `valid === false` (e.g. settled), we fall
 * back to "—".
 */

import { useMemo } from "react";
import { useReadContract } from "wagmi";
import { type Address, formatUnits } from "viem";
import {
  SYNDICATE_GOVERNOR_ABI,
  ISTRATEGY_ABI,
  formatAsset,
} from "@/lib/contracts";

type Call = { target: Address; data: `0x${string}`; value: bigint };

interface ActivePositionValueProps {
  governorAddress: Address;
  proposalId: bigint;
  chainId: number;
  assetAddress: Address;
  assetDecimals: number;
  assetSymbol: string;
  /** Gross capital that left the vault — used to show Δ vs entry. */
  deployedCapital: bigint;
}

const REFRESH_MS = 30_000;

export default function ActivePositionValue({
  governorAddress,
  proposalId,
  chainId,
  assetAddress,
  assetDecimals,
  assetSymbol,
  deployedCapital,
}: ActivePositionValueProps) {
  // Step 1 — pull the execute calls so we can find the strategy clone.
  const { data: callsData } = useReadContract({
    address: governorAddress,
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getExecuteCalls",
    args: [proposalId],
    chainId,
  });

  const strategyAddress = useMemo<Address | undefined>(() => {
    const calls = (callsData as readonly Call[] | undefined) ?? [];
    if (calls.length === 0) return undefined;
    // Prefer the first target that isn't the deposit asset (skips `approve`).
    const assetLower = assetAddress.toLowerCase();
    const nonAsset = calls.find(
      (c) => c.target.toLowerCase() !== assetLower,
    );
    return (nonAsset?.target ?? calls[calls.length - 1]?.target) as Address;
  }, [callsData, assetAddress]);

  // Step 2 — read positionValue() on the clone. Refreshes every 30s so LPs
  // see the live number without a manual reload.
  const { data: pvData, isLoading, isError } = useReadContract({
    address: strategyAddress,
    abi: ISTRATEGY_ABI,
    functionName: "positionValue",
    chainId,
    query: {
      enabled: !!strategyAddress,
      refetchInterval: REFRESH_MS,
      refetchIntervalInBackground: false,
      // Clones from before #218 revert on this call — don't spam retries.
      retry: false,
    },
  });

  const [value, valid] = (pvData as readonly [bigint, boolean] | undefined) ?? [
    0n,
    false,
  ];

  const display = (() => {
    if (!strategyAddress) return "—";
    if (isError) return "n/a";
    if (isLoading) return "…";
    if (!valid) return "—";
    return `${formatAsset(value, assetDecimals)} ${assetSymbol}`;
  })();

  // Δ vs deployedCapital — shown only when we actually have a live read.
  const deltaNode = (() => {
    if (!valid || !strategyAddress || isError || isLoading) return null;
    if (deployedCapital === 0n) return null;
    const delta = value - deployedCapital;
    const sign = delta >= 0n ? "+" : "−";
    const abs = delta < 0n ? -delta : delta;
    const pctNum =
      (Number(formatUnits(abs, assetDecimals)) /
        Number(formatUnits(deployedCapital, assetDecimals))) *
      100;
    const color =
      delta > 0n
        ? "var(--color-accent)"
        : delta < 0n
          ? "#ff6b6b"
          : "rgba(255,255,255,0.5)";
    return (
      <div
        style={{
          marginTop: "0.25rem",
          fontSize: "10px",
          letterSpacing: "0.04em",
          color,
          fontFamily: "var(--font-geist-mono), monospace",
        }}
      >
        {sign}
        {formatAsset(abs, assetDecimals)} {assetSymbol} (
        {sign}
        {pctNum.toFixed(2)}%)
      </div>
    );
  })();

  const title = isError
    ? "This strategy predates the positionValue() view (PR #218)."
    : !strategyAddress
      ? "Loading strategy address from governor…"
      : !valid && !isLoading
        ? "positionValue() reported not-yet-valid (strategy may be post-settle)."
        : undefined;

  return (
    <div className="sh-card--metric" title={title}>
      <div className="metric-label">Position Value</div>
      <div className="metric-val" style={{ fontSize: "1rem" }}>
        {display}
      </div>
      {deltaNode}
    </div>
  );
}
