"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt, useChainId } from "wagmi";
import { type Address } from "viem";
import { SYNDICATE_GOVERNOR_ABI, formatShares, getAddresses } from "@/lib/contracts";
import { useToast } from "@/components/ui/Toast";
import { trackTxSubmitted, trackTxConfirmed, trackTxFailed, classifyError } from "@/lib/analytics";

interface VoteButtonProps {
  governorAddress: Address;
  proposalId: bigint;
  voteEnd: bigint;
  /** Fired on tx submit so the parent can apply an optimistic vote-bar update. */
  onOptimistic?: (weight: bigint, support: 0 | 1) => void;
  /** Fired on tx confirm OR error so the parent can drop the optimistic overlay
   *  (router.refresh re-fetches the canonical onchain numbers). */
  onResolved?: () => void;
}

export default function VoteButton({
  governorAddress,
  proposalId,
  voteEnd,
  onOptimistic,
  onResolved,
}: VoteButtonProps) {
  const router = useRouter();
  const toast = useToast();
  const chainId = useChainId();
  const { address, isConnected } = useAccount();
  const [votingEnded, setVotingEnded] = useState(
    () => voteEnd <= BigInt(Math.floor(Date.now() / 1000)),
  );

  // Re-check deadline every 15s so the UI updates after voting ends
  useEffect(() => {
    if (votingEnded) return;
    const id = setInterval(() => {
      if (voteEnd <= BigInt(Math.floor(Date.now() / 1000))) {
        setVotingEnded(true);
        clearInterval(id);
      }
    }, 15_000);
    return () => clearInterval(id);
  }, [voteEnd, votingEnded]);

  const { data: hasVoted } = useReadContract({
    address: governorAddress,
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "hasVoted",
    args: address ? [proposalId, address] : undefined,
    query: { enabled: !!address && !votingEnded },
  });

  const { data: voteWeight } = useReadContract({
    address: governorAddress,
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getVoteWeight",
    args: address ? [proposalId, address] : undefined,
    query: { enabled: !!address },
  });

  const { writeContract, data: txHash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({ hash: txHash });

  // Local submitting flag — flips true synchronously inside castVote (before
  // wagmi's isPending catches up) so both FOR/AGAINST buttons lock out as
  // soon as the user clicks. Without this there's a window between
  // onOptimistic firing and isPending becoming true where a second click
  // could overwrite the optimistic bar with the opposite direction.
  const [submitting, setSubmitting] = useState(false);

  // Re-fetch page data once the vote tx is confirmed
  useEffect(() => {
    if (isConfirmed && txHash) {
      trackTxConfirmed("vote", governorAddress, txHash);
      toast.success(
        "Vote confirmed",
        `Proposal #${proposalId.toString()} — your vote is recorded onchain.`,
      );
      router.refresh();
      setSubmitting(false);
      // Drop the optimistic overlay — refresh will pull canonical numbers.
      onResolved?.();
    }
  }, [isConfirmed, router, txHash, governorAddress, proposalId, toast, onResolved]);

  const busy = submitting || isPending || isConfirming;
  const explorerUrl = getAddresses(chainId)?.blockExplorer;

  function castVote(support: 0 | 1) {
    // Re-check at click time to prevent submitting after deadline
    if (voteEnd <= BigInt(Math.floor(Date.now() / 1000))) {
      setVotingEnded(true);
      return;
    }
    // Belt-and-suspenders: ignore if already mid-flight.
    if (submitting || isPending || isConfirming) return;
    setSubmitting(true);
    // Apply optimistic overlay BEFORE writeContract so the UI updates the
    // moment the user clicks (before the wallet popup even appears).
    if (voteWeight && voteWeight > 0n) {
      onOptimistic?.(voteWeight, support);
    }
    writeContract(
      {
        address: governorAddress,
        abi: SYNDICATE_GOVERNOR_ABI,
        functionName: "vote",
        args: [proposalId, support],
      },
      {
        onSuccess: (hash) => trackTxSubmitted("vote", governorAddress, hash),
        onError: (err) => {
          const reason = classifyError(err);
          trackTxFailed("vote", governorAddress, reason);
          setSubmitting(false);
          // Roll back the optimistic overlay on submission failure (rejected
          // signatures, RPC errors, etc.) so the bar reverts immediately.
          onResolved?.();
          if (reason !== "user_rejected") {
            const msg = (err as { shortMessage?: string }).shortMessage || err.message;
            toast.error("Vote failed", msg);
          }
        },
      },
    );
  }

  const btnBase: React.CSSProperties = {
    fontFamily: "var(--font-plus-jakarta), sans-serif",
    fontSize: "11px",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    padding: "0.5rem 1rem",
    border: "1px solid",
    cursor: "pointer",
    transition: "all 0.2s ease",
  };

  if (!isConnected) {
    return (
      <div
        style={{
          fontSize: "11px",
          color: "rgba(255,255,255,0.4)",
          fontFamily: "var(--font-plus-jakarta), sans-serif",
          border: "1px solid rgba(255,255,255,0.15)",
          display: "inline-block",
          padding: "0.4rem 0.8rem",
          cursor: "default",
          letterSpacing: "0.05em",
        }}
      >
        [ CONNECT WALLET TO VOTE ]
      </div>
    );
  }

  if (votingEnded) {
    return (
      <div
        style={{
          fontSize: "11px",
          color: "rgba(255,255,255,0.3)",
          fontFamily: "var(--font-plus-jakarta), sans-serif",
          padding: "0.5rem 0",
        }}
      >
        Voting ended
      </div>
    );
  }

  if (hasVoted) {
    return (
      <div
        style={{
          fontSize: "11px",
          color: "var(--color-accent)",
          fontFamily: "var(--font-plus-jakarta), sans-serif",
          padding: "0.5rem 0",
        }}
      >
        Voted ✓
      </div>
    );
  }

  if (voteWeight === 0n) {
    return (
      <div
        style={{
          fontSize: "11px",
          color: "rgba(255,255,255,0.3)",
          fontFamily: "var(--font-plus-jakarta), sans-serif",
          padding: "0.5rem 0",
        }}
      >
        No shares at snapshot
      </div>
    );
  }

  return (
    <div>
      {voteWeight !== undefined && voteWeight > 0n && (
        <div
          style={{
            fontSize: "10px",
            color: "rgba(255,255,255,0.4)",
            fontFamily: "var(--font-plus-jakarta), sans-serif",
            marginBottom: "0.5rem",
          }}
        >
          Vote power: {formatShares(voteWeight)} shares
        </div>
      )}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          onClick={() => castVote(0)}
          disabled={busy}
          style={{
            ...btnBase,
            background: busy ? "transparent" : "rgba(46, 230, 166, 0.15)",
            color: "var(--color-accent)",
            borderColor: "var(--color-accent)",
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? "..." : "Vote FOR"}
        </button>
        <button
          onClick={() => castVote(1)}
          disabled={busy}
          style={{
            ...btnBase,
            background: busy ? "transparent" : "rgba(255, 77, 77, 0.15)",
            color: "#ff4d4d",
            borderColor: "#ff4d4d",
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? "..." : "Vote AGAINST"}
        </button>
      </div>
      {busy && txHash && explorerUrl && (
        <div style={{ marginTop: "0.5rem" }}>
          <a
            href={`${explorerUrl}/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "10px",
              letterSpacing: "0.1em",
              color: "var(--color-accent)",
              textDecoration: "underline",
            }}
          >
            View pending tx ↗
          </a>
        </div>
      )}
    </div>
  );
}
