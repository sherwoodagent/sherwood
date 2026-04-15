"use client";

/**
 * RedemptionUnlockWatcher — fires a toast when redemptions unlock on a
 * vault the user holds shares in.
 *
 * Polls `redemptionsLocked()` every 30s while the user has > 0 shares.
 * Fires once per (vault, lock-cycle) — uses sessionStorage to avoid
 * spamming if the user navigates away and back.
 *
 * Mounted on the syndicate vault page only. Disconnected wallets, users
 * with no shares, and vaults that are already unlocked are no-ops.
 */

import { useEffect, useRef } from "react";
import { useAccount, useReadContract, usePublicClient } from "wagmi";
import { type Address } from "viem";
import { SYNDICATE_VAULT_ABI } from "@/lib/contracts";
import { useToast } from "@/components/ui/Toast";
import { useRouter } from "next/navigation";

interface Props {
  vault: Address;
  vaultName: string;
  chainId: number;
}

const POLL_MS = 30_000;
const SEEN_KEY_PREFIX = "sherwood_unlock_seen:";

function markSeen(key: string) {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(`${SEEN_KEY_PREFIX}${key}`, "1");
  } catch {
    // ignore
  }
}

function hasSeen(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(`${SEEN_KEY_PREFIX}${key}`) === "1";
  } catch {
    return false;
  }
}

export default function RedemptionUnlockWatcher({ vault, vaultName, chainId }: Props) {
  const { address, isConnected } = useAccount();
  const client = usePublicClient({ chainId });
  const toast = useToast();
  const router = useRouter();

  // Only watch when the user actually holds shares — otherwise unlock
  // notifications are noise.
  const { data: shareBalance } = useReadContract({
    address: vault,
    abi: SYNDICATE_VAULT_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: isConnected && !!address },
  });
  // Derive a stable boolean for the effect dep — the raw bigint refetches
  // every few seconds via wagmi's polling, which would otherwise tear down
  // the 30s interval and reset the first-observation guard on every poll.
  const hasShares = !!shareBalance && shareBalance > 0n;

  // Track the last observed locked state so we can detect the locked → open
  // transition (the only thing worth notifying on).
  const lastLockedRef = useRef<boolean | null>(null);

  useEffect(() => {
    if (!client || !isConnected) return;
    if (!hasShares) return;

    let cancelled = false;

    async function poll() {
      if (!client) return;
      try {
        const locked = (await client.readContract({
          address: vault,
          abi: SYNDICATE_VAULT_ABI,
          functionName: "redemptionsLocked",
        })) as boolean;
        if (cancelled) return;

        const prev = lastLockedRef.current;
        lastLockedRef.current = locked;

        // First observation — record without firing.
        if (prev === null) return;

        // Detect the locked → open transition.
        if (prev === true && locked === false) {
          // De-dupe per (wallet, vault, "this cycle"). The cycle key is
          // intentionally cheap — once the user has acknowledged this
          // unlock event in this session, don't re-fire on future polls.
          const key = `${chainId}:${vault.toLowerCase()}:${address?.toLowerCase()}`;
          if (hasSeen(key)) return;
          markSeen(key);

          toast.success(
            "Redemptions unlocked",
            `${vaultName} is accepting withdrawals again.`,
          );
          // Refresh the page so VaultOverview's lock badge + WithdrawButton
          // pick up the new state without a manual reload.
          router.refresh();
        }

        // Re-arm the seen flag when we lock again, so the next unlock
        // can fire a fresh toast.
        if (prev === false && locked === true) {
          if (typeof window !== "undefined") {
            try {
              const key = `${chainId}:${vault.toLowerCase()}:${address?.toLowerCase()}`;
              sessionStorage.removeItem(`${SEEN_KEY_PREFIX}${key}`);
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // Network blip — try again next tick.
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // hasShares (boolean), not shareBalance (bigint) — see above.
  }, [client, isConnected, hasShares, vault, vaultName, chainId, address, toast, router]);

  return null;
}
