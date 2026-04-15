"use client";

/**
 * ChainGuard — sticky banner shown when the connected wallet is on a chain
 * that isn't one of Sherwood's supported chains. Offers a one-click switch
 * to the page-relevant chain (when known) or the first configured chain
 * as a fallback. Invisible when disconnected or already on a supported
 * chain — including when the user is correctly on the page's chain.
 */

import { useEffect } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { CHAINS } from "@/lib/contracts";
import { useToast } from "@/components/ui/Toast";
import { trackChainSwitchRequired } from "@/lib/analytics";
import { useTargetChainId } from "@/components/TargetChainContext";

interface ChainGuardProps {
  /** Chain the current page is anchored to (e.g. the syndicate's chain).
   *  Overrides the value in TargetChainContext. When neither is set, the
   *  banner falls back to the first configured chain. */
  targetChainId?: number;
}

export default function ChainGuard({ targetChainId: targetChainIdProp }: ChainGuardProps = {}) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();
  const toast = useToast();
  // Prop wins, then page context, then null (use first configured chain).
  const ctxTargetChainId = useTargetChainId();
  const targetChainId = targetChainIdProp ?? ctxTargetChainId ?? undefined;

  const supported = Object.keys(CHAINS).map((n) => Number(n));

  // If a page-specific target chain is provided, the user must be on THAT
  // chain to be considered "right". Otherwise, any supported chain works.
  const onSupportedChain = supported.includes(chainId);
  const onTargetChain = targetChainId ? chainId === targetChainId : onSupportedChain;
  const isWrongChain = isConnected && !onTargetChain;

  // Resolve target chain — page-supplied wins, else first configured chain.
  const targetEntry =
    (targetChainId && CHAINS[targetChainId]) || Object.values(CHAINS)[0];
  const targetId = targetEntry?.chain.id;
  const targetName = targetEntry?.chain.name ?? "Base";

  // Telemetry: record exposure to the wrong-chain banner
  useEffect(() => {
    if (isWrongChain && targetId) {
      trackChainSwitchRequired(chainId, targetId);
    }
  }, [isWrongChain, chainId, targetId]);

  if (!isWrongChain) return null;

  return (
    <div className="chain-banner" role="alert">
      <div className="chain-banner__text">
        <span className="chain-banner__dot" aria-hidden="true" />
        <span>
          Wrong network detected. Sherwood is deployed on <strong>{targetName}</strong>.
        </span>
      </div>
      <button
        type="button"
        className="chain-banner__switch"
        disabled={isPending || !targetId}
        onClick={() => {
          if (!targetId) return;
          switchChain(
            { chainId: targetId },
            {
              onError: (err) =>
                toast.error("Network switch failed", err.message || "Please switch manually in your wallet."),
            },
          );
        }}
      >
        {isPending ? "Switching…" : `Switch to ${targetName}`}
      </button>
    </div>
  );
}
