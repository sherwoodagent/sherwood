"use client";

import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { type Address } from "viem";
import { SYNDICATE_GOVERNOR_ABI, formatUSDC } from "@/lib/contracts";

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
  const { address, isConnected } = useAccount();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const votingEnded = voteEnd <= now;

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
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({ hash: txHash });

  const busy = isPending || isConfirming;

  function castVote(support: boolean) {
    writeContract({
      address: governorAddress,
      abi: SYNDICATE_GOVERNOR_ABI,
      functionName: "vote",
      args: [proposalId, support],
    });
  }

  const btnBase: React.CSSProperties = {
    fontFamily: "var(--font-jetbrains-mono), monospace",
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
          color: "rgba(255,255,255,0.3)",
          fontFamily: "var(--font-jetbrains-mono), monospace",
          padding: "0.5rem 0",
        }}
      >
        Connect wallet to vote
      </div>
    );
  }

  if (votingEnded) {
    return (
      <div
        style={{
          fontSize: "11px",
          color: "rgba(255,255,255,0.3)",
          fontFamily: "var(--font-jetbrains-mono), monospace",
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
          fontFamily: "var(--font-jetbrains-mono), monospace",
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
          fontFamily: "var(--font-jetbrains-mono), monospace",
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
            fontFamily: "var(--font-jetbrains-mono), monospace",
            marginBottom: "0.5rem",
          }}
        >
          Vote power: {formatUSDC(voteWeight)} shares
        </div>
      )}
      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          onClick={() => castVote(true)}
          disabled={busy}
          style={{
            ...btnBase,
            background: busy ? "transparent" : "rgba(45, 212, 45, 0.15)",
            color: "var(--color-accent)",
            borderColor: "var(--color-accent)",
            opacity: busy ? 0.5 : 1,
          }}
        >
          {busy ? "..." : "Vote FOR"}
        </button>
        <button
          onClick={() => castVote(false)}
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
