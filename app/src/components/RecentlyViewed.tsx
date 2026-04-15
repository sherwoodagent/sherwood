"use client";

/**
 * RecentlyViewed — small horizontal strip of the last 5 syndicates the user
 * visited. Lives above the leaderboard table.
 *
 * - Push side: <RecentlyViewedTracker subdomain={...} name={...} chainId={...} />
 *   mounted once on the syndicate detail page. Records the visit on mount.
 * - Display side: <RecentlyViewedStrip /> renders the strip; SSR-safe via
 *   useSyncExternalStore so we don't paint stale entries during hydration.
 *
 * Storage: localStorage key `sherwood_recent`. Newest first, capped at 5.
 */

import Link from "next/link";
import { useEffect, useMemo, useSyncExternalStore } from "react";

const STORAGE_KEY = "sherwood_recent";
const MAX_ENTRIES = 5;

export interface RecentEntry {
  subdomain: string;
  name: string;
  chainId: number;
  visitedAt: number;
}

function read(): RecentEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as RecentEntry[]) : [];
  } catch {
    return [];
  }
}

function write(entries: RecentEntry[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
  } catch {
    // ignore quota / privacy errors
  }
}

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

function useRecentEntries(): RecentEntry[] {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => JSON.stringify(read()),
    () => "[]",
  );
  return useMemo(() => JSON.parse(snapshot) as RecentEntry[], [snapshot]);
}

/** Mount on syndicate detail pages. Records the visit + bumps it to the top. */
export function RecentlyViewedTracker({
  subdomain,
  name,
  chainId,
}: {
  subdomain: string;
  name: string;
  chainId: number;
}) {
  useEffect(() => {
    const current = read();
    const filtered = current.filter((e) => e.subdomain !== subdomain);
    const next: RecentEntry[] = [
      { subdomain, name, chainId, visitedAt: Date.now() },
      ...filtered,
    ].slice(0, MAX_ENTRIES);
    write(next);
  }, [subdomain, name, chainId]);
  return null;
}

/** Render the strip on the leaderboard. Returns null if empty. */
export function RecentlyViewedStrip() {
  const entries = useRecentEntries();
  if (!entries.length) return null;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.75rem 0",
        marginBottom: "1rem",
        borderBottom: "1px solid var(--color-border-soft)",
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "var(--color-fg-secondary)",
        }}
      >
        Recently viewed
      </span>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {entries.map((e) => (
          <Link
            key={e.subdomain}
            href={`/syndicate/${e.subdomain}`}
            style={{
              padding: "0.35rem 0.75rem",
              border: "1px solid var(--color-border-soft)",
              background: "rgba(255,255,255,0.02)",
              fontFamily: "var(--font-mono)",
              fontSize: "11px",
              color: "var(--color-fg)",
              textDecoration: "none",
              letterSpacing: "0.05em",
              transition: "border-color 0.15s ease, color 0.15s ease",
            }}
            className="hover:!border-[var(--color-accent)] hover:!text-[var(--color-accent)]"
          >
            {e.name}
            <span style={{ color: "var(--color-fg-secondary)", marginLeft: "0.5rem" }}>↗</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
