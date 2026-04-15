"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useSyncExternalStore, useState } from "react";
import CopyButton from "./CopyButton";

interface ReferralBannerProps {
  subdomain: string;
}

const STORAGE_PREFIX = "sherwood_referrer:";
const DISMISS_PREFIX = "sherwood_referrer_dismissed:";

/**
 * Shows a "Join this syndicate" banner when a visitor arrives via a referral
 * link (e.g., /syndicate/atlas?ref=42). The skill URL carries the subdomain
 * and referrer so the agent's CLI can join with the right context.
 *
 * - localStorage is keyed per-subdomain so two referral links to two syndicates
 *   no longer overwrite each other (was: single global `sherwood_referrer`).
 * - Dismissible per-subdomain. Dismissal persists across reloads.
 *
 * Uses useSyncExternalStore for SSR-safe localStorage subscription —
 * avoids the setState-in-effect anti-pattern.
 */

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function makeSnapshotGetter(key: string) {
  return () => {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
}

export default function ReferralBanner({ subdomain }: ReferralBannerProps) {
  const searchParams = useSearchParams();
  const refParam = searchParams.get("ref");

  const cachedRef = useSyncExternalStore(
    subscribe,
    makeSnapshotGetter(`${STORAGE_PREFIX}${subdomain}`),
    () => null,
  );
  const dismissedFlag = useSyncExternalStore(
    subscribe,
    makeSnapshotGetter(`${DISMISS_PREFIX}${subdomain}`),
    () => null,
  );

  // Local override so dismissing closes the banner immediately
  const [dismissedNow, setDismissedNow] = useState(false);

  // Persist URL ref to localStorage when it appears. Must live in an effect —
  // writing during render is a React rule violation (render functions must be
  // pure) and the StorageEvent dispatched by setItem would re-trigger the
  // useSyncExternalStore subscription mid-render under concurrent mode.
  useEffect(() => {
    if (!refParam || refParam === cachedRef) return;
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${subdomain}`, refParam);
    } catch {
      // ignore quota / privacy errors
    }
  }, [refParam, cachedRef, subdomain]);

  const effectiveRef = refParam ?? cachedRef;
  const isDismissed = dismissedFlag === "1" || dismissedNow;
  if (!effectiveRef || isDismissed) return null;

  const skillUrl = `https://sherwood.sh/skill.md?subdomain=${encodeURIComponent(subdomain)}&ref=${encodeURIComponent(effectiveRef)}`;

  function handleDismiss() {
    try {
      localStorage.setItem(`${DISMISS_PREFIX}${subdomain}`, "1");
    } catch {
      // ignore
    }
    setDismissedNow(true);
  }

  return (
    <div
      role="region"
      aria-label="Join syndicate via referral"
      style={{
        background: "rgba(46, 230, 166, 0.06)",
        border: "1px solid rgba(46, 230, 166, 0.18)",
        padding: "1rem 1.25rem",
        marginBottom: "1.5rem",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "1rem",
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <div
          className="font-[family-name:var(--font-plus-jakarta)]"
          style={{ color: "var(--color-accent)", fontSize: "13px", fontWeight: 600 }}
        >
          Join this syndicate
        </div>
        <div
          className="font-[family-name:var(--font-plus-jakarta)]"
          style={{ color: "rgba(255,255,255,0.55)", fontSize: "11px" }}
        >
          Referred by agent #{effectiveRef}. Install the Sherwood Skill to get started.
        </div>
      </div>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        <CopyButton text="Copy Skill URL" copyValue={skillUrl} />
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss referral banner"
          className="sh-btn sh-btn--ghost sh-btn--sm"
          style={{ padding: "0.25rem 0.6rem", minHeight: "32px" }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
