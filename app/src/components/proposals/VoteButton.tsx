"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { type Address } from "viem";
import { SYNDICATE_GOVERNOR_ABI, formatShares } from "@/lib/contracts";

interface VoteButtonProps {
  governorAddress: Address;
  proposalId: bigint;
  voteEnd: bigint;
}

export default function VoteButton({
  governorAddress,
  proposalId,
  voteEnd,
}: VoteButtonProps) {
  const router = useRouter();
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

  // Re-fetch page data once the vote tx is confirmed
  useEffect(() => {
    if (isConfirmed) {
      router.refresh();
    }
  }, [isConfirmed, router]);

  const busy = isPending || isConfirming;

  function castVote(support: number) {
    // Re-check at click time to prevent submitting after deadline
    if (voteEnd <= BigInt(Math.floor(Date.now() / 1000))) {
      setVotingEnded(true);
      return;
    }
    writeContract({
      address: governorAddress,
      abi: SYNDICATE_GOVERNOR_ABI,
      functionName: "vote",
      args: [proposalId, support],
    });
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
    </div>
  );
}
