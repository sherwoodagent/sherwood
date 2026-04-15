"use client";

/**
 * RedemptionLockStatus — surfaces *why* redemptions are locked and *when*
 * they'll unlock. Reads the active proposal from the governor and computes
 * `executedAt + strategyDuration` as the unlock target.
 *
 * When no governor is deployed or no active proposal exists, renders a
 * static LOCKED pill with a tooltip hint.
 */

import { useReadContract } from "wagmi";
import { type Address } from "viem";
import {
  SYNDICATE_VAULT_ABI,
  SYNDICATE_GOVERNOR_ABI,
} from "@/lib/contracts";
import { Countdown } from "@/components/ui/Countdown";
import { Tooltip } from "@/components/ui/Tooltip";

interface Props {
  vault: Address;
  chainId: number;
  /** Initial lock state from server data. */
  initialLocked: boolean;
}

export default function RedemptionLockStatus({ vault, chainId, initialLocked }: Props) {
  // Resolve governor via vault (cheap call + cached)
  const { data: factoryGovernor } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "governor",
    chainId,
  });

  const governor = factoryGovernor as Address | undefined;

  const { data: activeProposalId } = useReadContract({
    address: governor,
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getActiveProposal",
    args: [vault],
    chainId,
    query: { enabled: !!governor, refetchInterval: 30_000 },
  });

  const { data: proposal } = useReadContract({
    address: governor,
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getProposal",
    args: activeProposalId ? [activeProposalId as bigint] : undefined,
    chainId,
    query: { enabled: !!governor && !!activeProposalId && (activeProposalId as bigint) > 0n },
  });

  const unlockAt = (() => {
    if (!proposal) return 0n;
    const p = proposal as unknown as { executedAt: bigint; strategyDuration: bigint };
    if (!p.executedAt || p.executedAt === 0n) return 0n;
    return p.executedAt + p.strategyDuration;
  })();

  const now = Math.floor(Date.now() / 1000);

  if (!initialLocked && unlockAt <= BigInt(now)) {
    return (
      <span className="sh-badge sh-badge--success" aria-label="Redemptions open">
        Open
      </span>
    );
  }

  if (unlockAt > BigInt(now)) {
    return (
      <Tooltip content="Locked while the active strategy runs. Unlocks when the strategy settles onchain.">
        <span style={{ display: "inline-flex", gap: "0.5rem", alignItems: "center" }}>
          <span className="sh-badge sh-badge--danger">Locked</span>
          <Countdown to={unlockAt} whenDone="Unlocking…" />
        </span>
      </Tooltip>
    );
  }

  // initialLocked but no unlock time — fallback tooltip
  return (
    <Tooltip content="Redemptions are locked. The active strategy hasn't started yet or unlock time is unknown.">
      <span className="sh-badge sh-badge--danger">Locked</span>
    </Tooltip>
  );
}
