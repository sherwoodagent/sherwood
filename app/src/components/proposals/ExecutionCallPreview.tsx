"use client";

/**
 * ExecutionCallPreview — fetches the execution calls for a proposal and
 * renders a decoded, expandable summary.
 *
 * Each row shows: target contract · decoded function name (when known) ·
 * 4-byte selector · ETH value. Click a row to reveal the full calldata
 * with a copy button so voters can decode parameters externally.
 */

import { useState } from "react";
import { useReadContract } from "wagmi";
import { type Address, formatEther } from "viem";
import { SYNDICATE_GOVERNOR_ABI, truncateAddress } from "@/lib/contracts";
import { decodeSelector } from "@/lib/selector-registry";

interface ExecutionCallPreviewProps {
  governorAddress: Address;
  proposalId: bigint;
  chainId: number;
  explorerUrl: string;
}

type Call = { target: Address; data: `0x${string}`; value: bigint };

function CalldataBlock({ data }: { data: `0x${string}` }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(data);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — leave the data visible for manual copy
    }
  }

  return (
    <div className="exec-preview__calldata">
      <div className="exec-preview__calldata-head">
        <span>calldata · {data.length / 2 - 1} bytes</span>
        <button
          type="button"
          onClick={copy}
          className="exec-preview__copy"
          aria-label="Copy calldata"
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <code className="exec-preview__calldata-body">{data}</code>
    </div>
  );
}

function CallRow({
  call,
  index,
  explorerUrl,
}: {
  call: Call;
  index: number;
  explorerUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const selector = call.data.length >= 10 ? call.data.slice(0, 10) : "0x";
  const decoded = decodeSelector(selector);
  const hasArgs = call.data.length > 10;

  return (
    <>
      <div
        className={`exec-preview__row ${hasArgs ? "exec-preview__row--clickable" : ""}`}
        onClick={hasArgs ? () => setOpen((v) => !v) : undefined}
        role={hasArgs ? "button" : undefined}
        tabIndex={hasArgs ? 0 : undefined}
        onKeyDown={
          hasArgs
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setOpen((v) => !v);
                }
              }
            : undefined
        }
      >
        <span className="exec-preview__idx">
          {hasArgs ? (open ? "▾" : "▸") : " "} {String(index + 1).padStart(2, "0")}
        </span>
        <a
          href={`${explorerUrl}/address/${call.target}`}
          target="_blank"
          rel="noopener noreferrer"
          className="exec-preview__target"
          onClick={(e) => e.stopPropagation()}
        >
          {truncateAddress(call.target)} ↗
        </a>
        <span className="exec-preview__sig">
          {decoded ? (
            <>
              <span className="exec-preview__sig-name">{decoded}</span>
              <span className="exec-preview__sig-sel">{selector}</span>
            </>
          ) : (
            <code className="exec-preview__selector">{selector}</code>
          )}
        </span>
        <span className="exec-preview__val">
          {call.value > 0n ? `${formatEther(call.value)} ETH` : "—"}
        </span>
      </div>
      {open && hasArgs && <CalldataBlock data={call.data} />}
    </>
  );
}

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
    <details className="exec-preview" open>
      <summary className="exec-preview__summary">
        <span className="exec-preview__label">Execution plan</span>
        <span className="exec-preview__count">
          {isLoading
            ? "loading…"
            : isError
              ? "unavailable"
              : `${calls.length} call${calls.length === 1 ? "" : "s"}`}
        </span>
      </summary>
      {isLoading && (
        <div className="exec-preview__empty">Fetching calldata from governor…</div>
      )}
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
            <span>Function</span>
            <span>Value</span>
          </div>
          {calls.map((c, i) => (
            <CallRow
              key={`${c.target}-${i}`}
              call={c}
              index={i}
              explorerUrl={explorerUrl}
            />
          ))}
          <div className="exec-preview__note">
            Names decoded from a local registry of common DeFi selectors.
            Click a row to expand the full calldata.
          </div>
        </div>
      )}
    </details>
  );
}
