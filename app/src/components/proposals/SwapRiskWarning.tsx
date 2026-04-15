"use client";

/**
 * SwapRiskWarning — detects whether a proposal's execution calls target
 * a PortfolioStrategy and, if so, surfaces the strategy's maxSlippageBps
 * so LPs see the swap tolerance the agent set before voting.
 *
 * Hidden entirely when the strategy isn't a PortfolioStrategy or when
 * the calls can't be read. Yellow warning band when slippage > 300 bps.
 */

import { useEffect, useState } from "react";
import { type Address } from "viem";
import { useReadContract } from "wagmi";
import {
  SYNDICATE_GOVERNOR_ABI,
  PORTFOLIO_STRATEGY_ABI,
  getPublicClient,
} from "@/lib/contracts";
import { Term } from "@/components/ui/Glossary";

interface SwapRiskWarningProps {
  governorAddress: Address;
  proposalId: bigint;
  chainId: number;
}

type Call = { target: Address; data: `0x${string}`; value: bigint };

const HIGH_SLIPPAGE_BPS = 300; // > 3% triggers the warning band.

export default function SwapRiskWarning({
  governorAddress,
  proposalId,
  chainId,
}: SwapRiskWarningProps) {
  const { data: callsData } = useReadContract({
    address: governorAddress,
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getExecuteCalls",
    args: [proposalId],
    chainId,
  });

  const [strategyAddress, setStrategyAddress] = useState<Address | null>(null);
  const [maxSlippageBps, setMaxSlippageBps] = useState<number | null>(null);

  // Strategy detection + slippage read. Separated from wagmi because
  // wagmi can't conditionally read from an address that isn't known
  // until after callsData resolves, and we'd prefer not to issue
  // reads for every call target.
  useEffect(() => {
    const calls = (callsData as readonly Call[] | undefined) ?? [];
    if (calls.length < 2) return;

    let cancelled = false;
    (async () => {
      const client = getPublicClient(chainId);
      // Strategy clone is typically the second call (first is asset approval).
      for (let i = 1; i < calls.length; i++) {
        try {
          const name = await client.readContract({
            address: calls[i].target,
            abi: PORTFOLIO_STRATEGY_ABI,
            functionName: "name",
          });
          if (name === "Portfolio") {
            if (cancelled) return;
            setStrategyAddress(calls[i].target);
            const bps = await client.readContract({
              address: calls[i].target,
              abi: PORTFOLIO_STRATEGY_ABI,
              functionName: "maxSlippageBps",
            });
            if (cancelled) return;
            setMaxSlippageBps(Number(bps));
            return;
          }
        } catch {
          // Not a strategy — continue
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [callsData, chainId]);

  if (maxSlippageBps === null || strategyAddress === null) return null;

  const pct = (maxSlippageBps / 100).toFixed(2);
  const isHigh = maxSlippageBps > HIGH_SLIPPAGE_BPS;

  return (
    <div
      className="swap-risk-warning"
      style={{
        marginTop: "0.75rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.6rem",
          padding: "0.4rem 0.75rem",
          border: `1px solid ${isHigh ? "rgba(234, 179, 8, 0.45)" : "var(--color-border-soft)"}`,
          background: isHigh
            ? "rgba(234, 179, 8, 0.08)"
            : "rgba(255, 255, 255, 0.02)",
          color: isHigh ? "#eab308" : "rgba(255, 255, 255, 0.7)",
          fontFamily: "var(--font-mono)",
          fontSize: "11px",
          letterSpacing: "0.05em",
          width: "fit-content",
        }}
        title="Max slippage tolerance set on the strategy clone."
      >
        <span style={{ opacity: 0.7 }}>
          Max <Term k="slippage">slippage</Term>
        </span>
        <strong style={{ fontWeight: 600 }}>{pct}%</strong>
        {isHigh && (
          <span
            style={{
              fontSize: "9px",
              letterSpacing: "0.22em",
              padding: "1px 6px",
              background: "rgba(234, 179, 8, 0.22)",
              textTransform: "uppercase",
            }}
          >
            High
          </span>
        )}
      </div>
      {isHigh && (
        <div
          role="note"
          style={{
            padding: "0.6rem 0.8rem",
            border: "1px dashed rgba(234, 179, 8, 0.35)",
            background: "rgba(234, 179, 8, 0.05)",
            color: "rgba(234, 179, 8, 0.9)",
            fontSize: "12px",
            lineHeight: 1.5,
          }}
        >
          High <Term k="slippage">slippage</Term> tolerance — this strategy may
          execute at a worse price than the quote shown. Swap-heavy proposals
          are also susceptible to <Term k="mev">MEV</Term>; consider waiting
          for a pool with deeper liquidity or asking the proposer to tighten
          the tolerance.
        </div>
      )}
    </div>
  );
}
