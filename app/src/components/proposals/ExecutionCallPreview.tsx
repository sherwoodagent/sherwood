"use client";

/**
 * ExecutionCallPreview — client component that fetches the execution calls
 * for a proposal and renders a collapsible, decoded summary.
 *
 * Shows target contract, 4-byte selector, ETH value per call. Full calldata
 * available on demand. Gives LPs visibility into what will actually execute
 * onchain before they vote.
 */

import { useReadContract } from "wagmi";
import { type Address, formatEther } from "viem";
import { SYNDICATE_GOVERNOR_ABI, truncateAddress } from "@/lib/contracts";

interface ExecutionCallPreviewProps {
  governorAddress: Address;
  proposalId: bigint;
  chainId: number;
  explorerUrl: string;
}

type Call = { target: Address; data: `0x${string}`; value: bigint };

export default function ExecutionCallPreview({
  governorAddress,
  proposalId,
  chainId,
  explorerUrl,
}: ExecutionCallPreviewProps) {
  const { data, isLoading, isError } = useReadContract({
    address: governorAddress,
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getExecuteCalls",
    args: [proposalId],
    chainId,
  });

  const calls = (data as readonly Call[] | undefined) ?? [];

  return (
    <details className="exec-preview">
      <summary className="exec-preview__summary">
        <span className="exec-preview__label">Execution plan</span>
        <span className="exec-preview__count">
          {isLoading ? "loading…" : isError ? "unavailable" : `${calls.length} call${calls.length === 1 ? "" : "s"}`}
        </span>
      </summary>
      {isLoading && <div className="exec-preview__empty">Fetching calldata from governor…</div>}
      {isError && (
        <div className="exec-preview__empty">
          Could not read execution calls. This proposal may pre-date storage changes.
        </div>
      )}
      {!isLoading && !isError && calls.length === 0 && (
        <div className="exec-preview__empty">
          No execution calls registered — proposer will submit calldata at execution time.
        </div>
      )}
      {!isLoading && !isError && calls.length > 0 && (
        <div className="exec-preview__body">
          <div className="exec-preview__head">
            <span>#</span>
            <span>Target</span>
            <span>Selector</span>
            <span>Value</span>
          </div>
          {calls.map((c, i) => {
            const selector = c.data.length >= 10 ? c.data.slice(0, 10) : "0x";
            return (
              <div key={`${c.target}-${i}`} className="exec-preview__row">
                <span className="exec-preview__idx">{String(i + 1).padStart(2, "0")}</span>
                <a
                  href={`${explorerUrl}/address/${c.target}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="exec-preview__target"
                >
                  {truncateAddress(c.target)} ↗
                </a>
                <code className="exec-preview__selector">{selector}</code>
                <span className="exec-preview__val">
                  {c.value > 0n ? `${formatEther(c.value)} ETH` : "—"}
                </span>
              </div>
            );
          })}
          <div className="exec-preview__note">
            Selectors are 4-byte function signatures. Decode with an ABI database
            (e.g. openchain.xyz) to see full parameters.
          </div>
        </div>
      )}
    </details>
  );
}
