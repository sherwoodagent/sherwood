"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CHAIN_BADGES, truncateAddress } from "@/lib/contracts";
import type { SyndicateDisplay } from "@/lib/syndicates";
import { Input } from "@/components/ui/Input";
import { Tabs } from "@/components/ui/Tabs";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Sparkline } from "@/components/ui/Sparkline";
import { RecentlyViewedStrip } from "@/components/RecentlyViewed";

const PAGE_SIZE = 25;
const WATCHLIST_KEY = "sherwood_watchlist";
/** Auto-refresh interval for the leaderboard table when the tab is
    visible. Server route is cached at 30s so this doesn't amplify load. */
const REFRESH_INTERVAL_MS = 30_000;
/** How long the rank-change flash persists on a row. */
const RANK_FLASH_MS = 3_000;

// ── Watchlist (localStorage-backed) ──────────────────────
function readWatchlist(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function writeWatchlist(set: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(Array.from(set)));
    // Manually fire a storage event for same-tab listeners
    window.dispatchEvent(new StorageEvent("storage", { key: WATCHLIST_KEY }));
  } catch {
    // ignore
  }
}

function watchlistSubscribe(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

function useWatchlist(): { has: (key: string) => boolean; toggle: (key: string) => void; size: number } {
  const snapshot = useSyncExternalStore(
    watchlistSubscribe,
    () => {
      const s = readWatchlist();
      // Stable snapshot key based on contents — useSyncExternalStore needs
      // referentially stable returns when no change has occurred.
      return JSON.stringify(Array.from(s).sort());
    },
    () => "[]",
  );

  const set = useMemo(() => new Set<string>(JSON.parse(snapshot)), [snapshot]);

  const has = useCallback((k: string) => set.has(k), [set]);
  const toggle = useCallback(
    (k: string) => {
      const next = new Set(set);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      writeWatchlist(next);
    },
    [set],
  );

  return { has, toggle, size: set.size };
}

function StarButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      aria-label={active ? `Remove ${label} from watchlist` : `Add ${label} to watchlist`}
      title={active ? "Remove from watchlist" : "Add to watchlist"}
      style={{
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: "4px",
        color: active ? "var(--color-accent)" : "rgba(255,255,255,0.3)",
        fontSize: "14px",
        lineHeight: 1,
        transition: "color 0.15s ease",
      }}
    >
      {active ? "★" : "☆"}
    </button>
  );
}

interface RankedSyndicate extends SyndicateDisplay {
  tvlNum: number;
  tvlUSDDisplay: string;
}

interface LeaderboardTabsProps {
  syndicates: RankedSyndicate[];
}

type TabId = "syndicates" | "agents";
type ChainFilter = "all" | "8453" | "84532" | "999";
type StatusFilter = "all" | "ACTIVE_STRATEGY" | "VOTING" | "IDLE" | "NO_AGENTS";

// ── Sorting ────────────────────────────────────────────────
type SortKey = "tvl" | "agents" | "age" | "name";
type SortDir = "asc" | "desc";

const DEFAULT_SORT: { key: SortKey; dir: SortDir } = { key: "tvl", dir: "desc" };

/** Clickable sort-toggle rendered inside a <th>. */
function SortHeader({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  const arrow = !active ? "" : dir === "asc" ? " ▲" : " ▼";
  return (
    <button
      type="button"
      onClick={onClick}
      className="sh-sort-header"
      style={{
        background: "none",
        border: 0,
        padding: 0,
        font: "inherit",
        color: active ? "var(--color-accent)" : "inherit",
        cursor: "pointer",
        letterSpacing: "inherit",
        textTransform: "inherit",
      }}
    >
      {label}
      <span aria-hidden style={{ fontSize: "9px", opacity: active ? 1 : 0.3 }}>
        {arrow || " ⇅"}
      </span>
    </button>
  );
}

/**
 * Escape a user-controlled string for CSV export.
 *
 * Defends against spreadsheet formula injection (CVE-2014-3524 family):
 * a cell starting with `=`, `+`, `-`, `@`, tab, or CR is interpreted as
 * a formula by Excel and Google Sheets. Wrapping in double-quotes
 * alone isn't enough — the formula still fires. We prefix a leading
 * single apostrophe in those cases, then quote and escape embedded
 * quotes per RFC 4180.
 */
function csvCell(raw: string): string {
  const needsPrefix = /^[=+\-@\t\r]/.test(raw);
  const value = needsPrefix ? `'${raw}` : raw;
  return `"${value.replace(/"/g, '""')}"`;
}

function parseSortParam(raw: string | null): { key: SortKey; dir: SortDir } {
  if (!raw) return DEFAULT_SORT;
  const [k, d] = raw.split(":");
  const key =
    k === "tvl" || k === "agents" || k === "age" || k === "name" ? k : DEFAULT_SORT.key;
  const dir = d === "asc" ? "asc" : "desc";
  return { key, dir };
}

function compareSyndicates(
  a: RankedSyndicate,
  b: RankedSyndicate,
  key: SortKey,
  dir: SortDir,
): number {
  let cmp = 0;
  switch (key) {
    case "tvl":
      cmp = a.tvlNum - b.tvlNum;
      break;
    case "agents":
      cmp = a.agentCount - b.agentCount;
      break;
    case "age":
      cmp = (a.ageDays ?? 0) - (b.ageDays ?? 0);
      break;
    case "name":
      cmp = a.name.localeCompare(b.name);
      break;
  }
  return dir === "asc" ? cmp : -cmp;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  ACTIVE_STRATEGY: { bg: "rgba(46,230,166,0.15)", text: "#2EE6A6", label: "Active" },
  VOTING: { bg: "rgba(234,179,8,0.15)", text: "#eab308", label: "Voting" },
  IDLE: { bg: "rgba(255,255,255,0.08)", text: "rgba(255,255,255,0.5)", label: "Idle" },
  NO_AGENTS: { bg: "rgba(255,77,77,0.15)", text: "#ff4d4d", label: "No agents" },
};

// Rank medal — gold/silver/bronze for top 3, plain mono digits thereafter.
// A `delta` arg surfaces the brief up/down flash when auto-refresh detects
// that a syndicate moved in rank since the previous tick.
function RankCell({
  index,
  delta,
}: {
  index: number;
  delta?: "up" | "down";
}) {
  const medalClass =
    index === 0
      ? "rank-medal rank-medal--gold"
      : index === 1
        ? "rank-medal rank-medal--silver"
        : index === 2
          ? "rank-medal rank-medal--bronze"
          : null;
  const deltaClass = delta ? `sh-rank-delta sh-rank-delta--${delta}` : "";
  const inner = medalClass ? (
    <span className={medalClass}>{String(index + 1).padStart(2, "0")}</span>
  ) : (
    <span className="rank-plain">{String(index + 1).padStart(2, "0")}</span>
  );
  if (!delta) return inner;
  return (
    <span className={deltaClass} title={delta === "up" ? "Moved up" : "Moved down"}>
      {inner}
    </span>
  );
}

// Directional P&L cell
function PnlDelta({ value, raw }: { value: string; raw: number }) {
  const dir = raw > 0 ? "up" : raw < 0 ? "down" : "flat";
  const label = raw === 0 ? value : value.replace(/^[+-]/, "");
  return <span className={`pnl-delta pnl-delta--${dir}`}>{label}</span>;
}

/**
 * Net-flow trend arrow, computed from the syndicate's lifetime
 * deposits vs withdrawals. Honest signal — not a fake sparkline.
 */
function FlowTrend({ trend }: { trend?: -1 | 0 | 1 }) {
  if (!trend) return <span style={{ color: "rgba(255,255,255,0.2)" }}>—</span>;
  const color =
    trend === 1
      ? "var(--color-accent)"
      : trend === -1
        ? "#ff4d4d"
        : "rgba(255,255,255,0.4)";
  const arrow = trend === 1 ? "▲" : trend === -1 ? "▼" : "·";
  const title =
    trend === 1
      ? "Net inflows over lifetime"
      : trend === -1
        ? "Net outflows over lifetime"
        : "Balanced flow";
  return (
    <span
      title={title}
      style={{
        color,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
      }}
    >
      {arrow}
    </span>
  );
}

function NewBadge({ ageDays }: { ageDays?: number }) {
  if (ageDays === undefined || ageDays > 7) return null;
  return (
    <span
      title={`Created ${ageDays}d ago`}
      style={{
        marginLeft: "0.4rem",
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        letterSpacing: "0.18em",
        padding: "1px 5px",
        background: "rgba(46, 230, 166, 0.15)",
        color: "var(--color-accent)",
        border: "1px solid rgba(46, 230, 166, 0.35)",
        verticalAlign: "middle",
      }}
    >
      NEW
    </span>
  );
}

export default function LeaderboardTabs({
  syndicates: initialSyndicates,
}: LeaderboardTabsProps) {
  // Deep-link support: ?syndicate=<subdomain> jumps to the row, scrolls into
  // view, briefly flashes accent. Designed for shared links (watchlist /
  // social) so they land on the right entry without manual filtering.
  const searchParams = useSearchParams();
  const deepLinkSubdomain = searchParams.get("syndicate");
  const initialSort = parseSortParam(searchParams.get("sort"));

  // Live-syncing data: starts from the SSR prop, then auto-refreshes from
  // the /api/leaderboard route every REFRESH_INTERVAL_MS when the tab is
  // visible. Everything downstream reads from this state, not the prop.
  const [syndicates, setSyndicates] = useState(initialSyndicates);
  // Mirror the latest syndicates into a ref so the mount-only polling
  // effect below can read current rankings (for delta detection) without
  // re-subscribing on every tick — which would otherwise reset the
  // setInterval timer on every successful fetch.
  const syndicatesRef = useRef(syndicates);
  useEffect(() => {
    syndicatesRef.current = syndicates;
  }, [syndicates]);

  // Compute the deep-link target's page once at mount via lazy initializer
  // so we don't need a setState-in-effect on first render.
  const deepLinkPage = useMemo(() => {
    if (!deepLinkSubdomain) return 0;
    const idx = syndicates.findIndex((s) => s.subdomain === deepLinkSubdomain);
    return idx >= 0 ? Math.floor(idx / PAGE_SIZE) : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkSubdomain]);

  const [tab, setTab] = useState<TabId>("syndicates");
  const [query, setQuery] = useState("");
  const [chain, setChain] = useState<ChainFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [page, setPage] = useState<number>(() => deepLinkPage);
  const [showWatchlistOnly, setShowWatchlistOnly] = useState(false);
  const [flashedKey, setFlashedKey] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>(initialSort.key);
  const [sortDir, setSortDir] = useState<SortDir>(initialSort.dir);
  const [rankDeltas, setRankDeltas] = useState<Record<string, "up" | "down">>(
    {},
  );
  const watchlist = useWatchlist();

  // ── Auto-refresh ─────────────────────────────────────────
  // Poll the cached /api/leaderboard route when the tab is visible.
  // Diff ranks against the previous tick (via syndicatesRef) to flash
  // the sh-rank-delta chip on rows that moved. Mount-only deps — the
  // timer must NOT be torn down on every tick (which would happen if
  // we depended on `syndicates`, since each successful fetch updates
  // it and invalidates this effect).
  useEffect(() => {
    let cancelled = false;

    async function tick() {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      try {
        const res = await fetch("/api/leaderboard", { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as RankedSyndicate[];
        if (cancelled) return;

        // Rank-change detection by syndicate key (chainId-id). Reads from
        // the ref so we always compare against the immediately-previous
        // tick, not a stale closure.
        const prev = syndicatesRef.current;
        const prevIdx = new Map<string, number>();
        prev.forEach((s, i) => prevIdx.set(`${s.chainId}-${s.id}`, i));
        const deltas: Record<string, "up" | "down"> = {};
        next.forEach((s, i) => {
          const key = `${s.chainId}-${s.id}`;
          const p = prevIdx.get(key);
          if (p !== undefined && p !== i) {
            deltas[key] = i < p ? "up" : "down";
          }
        });

        setSyndicates(next);
        if (Object.keys(deltas).length > 0) {
          setRankDeltas(deltas);
          setTimeout(() => {
            if (!cancelled) setRankDeltas({});
          }, RANK_FLASH_MS);
        }
      } catch {
        // Network hiccups are silent — the prior data is still visible.
      }
    }

    const timer = setInterval(tick, REFRESH_INTERVAL_MS);

    // Immediate refresh when the tab becomes visible again.
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // ── URL sort sync ────────────────────────────────────────
  // Keep ?sort= in sync with sort state so links are shareable.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (sortKey === DEFAULT_SORT.key && sortDir === DEFAULT_SORT.dir) {
      url.searchParams.delete("sort");
    } else {
      url.searchParams.set("sort", `${sortKey}:${sortDir}`);
    }
    window.history.replaceState(null, "", url.toString());
  }, [sortKey, sortDir]);

  // Reset page when filters change
  const resetPage = useCallback(() => setPage(0), []);

  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map());

  // Scroll + flash for deep-link target. Effect only handles the external
  // side-effect (scrollIntoView) and a timer-driven flash state — no
  // synchronous setState that depends on render-time props.
  useEffect(() => {
    if (!deepLinkSubdomain) return;
    const match = syndicates.find((s) => s.subdomain === deepLinkSubdomain);
    if (!match) return;
    const key = `${match.chainId}-${match.id}`;

    const scrollId = setTimeout(() => {
      const el = rowRefs.current.get(key);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashedKey(key);
    }, 120);
    const fadeId = setTimeout(() => setFlashedKey(null), 2600);
    return () => {
      clearTimeout(scrollId);
      clearTimeout(fadeId);
    };
  }, [deepLinkSubdomain, syndicates]);

  const agents = useMemo(
    () =>
      syndicates
        .flatMap((s) =>
          s.agents.map((a) => ({
            agentAddress: a.agentAddress,
            agentId: a.agentId,
            agentName: a.agentName,
            proposalCount: a.proposalCount,
            totalPnl: a.totalPnl,
            totalPnlRaw: a.totalPnlRaw,
            syndicateSubdomain: s.subdomain,
            syndicateName: s.name,
            chainId: s.chainId,
          })),
        )
        .sort((a, b) => b.totalPnlRaw - a.totalPnlRaw),
    [syndicates],
  );

  const filteredSyndicates = useMemo(() => {
    const filtered = syndicates.filter((s) => {
      if (showWatchlistOnly && !watchlist.has(`${s.chainId}:${s.id}`)) return false;
      if (chain !== "all" && String(s.chainId) !== chain) return false;
      if (status !== "all" && s.status !== status) return false;
      if (query) {
        const q = query.toLowerCase();
        if (
          !s.name.toLowerCase().includes(q) &&
          !s.subdomain.toLowerCase().includes(q) &&
          !s.strategy.toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
    return filtered.sort((a, b) => compareSyndicates(a, b, sortKey, sortDir));
  }, [syndicates, chain, status, query, showWatchlistOnly, watchlist, sortKey, sortDir]);

  // Toggle handler for sortable column headers.
  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        // Sensible default direction per column.
        setSortDir(key === "name" ? "asc" : "desc");
      }
    },
    [sortKey],
  );

  // CSV export — serializes the currently filtered + sorted view.
  const exportCsv = useCallback(() => {
    const header = [
      "rank",
      "name",
      "subdomain",
      "strategy",
      "tvl",
      "tvlUSD",
      "agents",
      "status",
      "chainId",
      "ageDays",
    ];
    const lines = [header.join(",")];
    filteredSyndicates.forEach((s, i) => {
      const row = [
        String(i + 1),
        csvCell(s.name),
        csvCell(s.subdomain),
        csvCell(s.strategy || ""),
        csvCell(s.tvl),
        s.tvlUSDDisplay || "",
        String(s.agentCount),
        csvCell(s.status),
        String(s.chainId),
        s.ageDays != null ? String(s.ageDays) : "",
      ];
      lines.push(row.join(","));
    });
    const csv = lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `sherwood-leaderboard-${stamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredSyndicates]);

  // Page slice for syndicates table
  const totalPages = Math.max(1, Math.ceil(filteredSyndicates.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pagedSyndicates = filteredSyndicates.slice(
    safePage * PAGE_SIZE,
    safePage * PAGE_SIZE + PAGE_SIZE,
  );

  const filteredAgents = useMemo(() => {
    return agents.filter((a) => {
      if (chain !== "all" && String(a.chainId) !== chain) return false;
      if (query) {
        const q = query.toLowerCase();
        const agentLabel = (a.agentName || "").toLowerCase();
        const synLabel = a.syndicateName.toLowerCase();
        const addr = a.agentAddress.toLowerCase();
        if (!agentLabel.includes(q) && !synLabel.includes(q) && !addr.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [agents, chain, query]);

  const activeChainIds = Array.from(new Set(syndicates.map((s) => s.chainId)));

  return (
    <div className="font-[family-name:var(--font-plus-jakarta)]">
      <RecentlyViewedStrip />

      <Tabs<TabId>
        items={[
          { id: "syndicates", label: "Syndicates", count: syndicates.length },
          { id: "agents", label: "Agents", count: agents.length },
        ]}
        active={tab}
        onChange={setTab}
        ariaLabel="Leaderboard view"
      />

      {/* Filter bar */}
      <div className="sh-filter-bar">
        <Input
          placeholder={tab === "syndicates" ? "Search syndicates, strategies, subdomains…" : "Search agents or addresses…"}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            resetPage();
          }}
          aria-label="Search"
        />

        <FilterDropdown
          label="Chain"
          value={chain}
          onChange={(v) => {
            setChain(v as ChainFilter);
            resetPage();
          }}
          options={[
            { value: "all", label: "All chains" },
            ...activeChainIds.map((id) => ({
              value: String(id),
              label: CHAIN_BADGES[id]?.label || String(id),
            })),
          ]}
        />

        {tab === "syndicates" && (
          <FilterDropdown
            label="Status"
            value={status}
            onChange={(v) => {
              setStatus(v as StatusFilter);
              resetPage();
            }}
            options={[
              { value: "all", label: "Any status" },
              { value: "ACTIVE_STRATEGY", label: "Active strategy" },
              { value: "VOTING", label: "Voting" },
              { value: "IDLE", label: "Idle" },
              { value: "NO_AGENTS", label: "No agents" },
            ]}
          />
        )}

        {tab === "syndicates" && watchlist.size > 0 && (
          <button
            type="button"
            onClick={() => {
              setShowWatchlistOnly((v) => !v);
              resetPage();
            }}
            className="sh-btn sh-btn--secondary sh-btn--sm"
            aria-pressed={showWatchlistOnly}
            style={{
              borderColor: showWatchlistOnly ? "var(--color-accent)" : undefined,
              color: showWatchlistOnly ? "var(--color-accent)" : undefined,
            }}
          >
            ★ Watchlist ({watchlist.size})
          </button>
        )}

        {tab === "syndicates" && filteredSyndicates.length > 0 && (
          <button
            type="button"
            onClick={exportCsv}
            className="sh-btn sh-btn--secondary sh-btn--sm"
            aria-label="Export current view as CSV"
            title="Export the current filtered view as CSV"
          >
            ⬇ CSV
          </button>
        )}

        <span
          style={{
            marginLeft: "auto",
            fontFamily: "var(--font-mono)",
            fontSize: "10px",
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            color: "var(--color-fg-secondary)",
          }}
        >
          {tab === "syndicates"
            ? `${filteredSyndicates.length} / ${syndicates.length}`
            : `${filteredAgents.length} / ${agents.length}`}{" "}
          · Ranked by all-time TVL
        </span>
      </div>

      {/* Syndicates tab */}
      {tab === "syndicates" && (
        <div className="table-container" style={{ borderTop: "none" }}>
          {filteredSyndicates.length === 0 ? (
            <EmptyState
              icon="Q.00"
              title={syndicates.length === 0 ? "No syndicates yet" : "No matching syndicates"}
              description={
                syndicates.length === 0
                  ? "Be the first — spin up a syndicate with the CLI."
                  : "Try clearing the filters or adjusting your search."
              }
              action={
                syndicates.length === 0 ? (
                  <a
                    href="https://docs.sherwood.sh/cli/commands#create"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="sh-btn sh-btn--primary sh-btn--sm"
                  >
                    Create a syndicate
                  </a>
                ) : (
                  <button
                    type="button"
                    className="sh-btn sh-btn--secondary sh-btn--sm"
                    onClick={() => {
                      setQuery("");
                      setChain("all");
                      setStatus("all");
                    }}
                  >
                    Clear filters
                  </button>
                )
              }
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col" style={{ width: "32px" }} aria-label="Watchlist"></th>
                  <th scope="col" style={{ width: "40px" }}>Rank</th>
                  <th
                    scope="col"
                    aria-sort={
                      sortKey === "name"
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <SortHeader
                      label="Syndicate"
                      active={sortKey === "name"}
                      dir={sortDir}
                      onClick={() => toggleSort("name")}
                    />
                  </th>
                  <th scope="col">Strategy</th>
                  <th
                    scope="col"
                    aria-sort={
                      sortKey === "tvl"
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <SortHeader
                      label="TVL"
                      active={sortKey === "tvl"}
                      dir={sortDir}
                      onClick={() => toggleSort("tvl")}
                    />
                  </th>
                  <th
                    scope="col"
                    style={{ width: "90px" }}
                    title="7-day TVL trajectory"
                  >
                    Trend (7D)
                  </th>
                  <th scope="col" style={{ width: "40px" }} title="Net deposit flow over lifetime">Flow</th>
                  <th
                    scope="col"
                    aria-sort={
                      sortKey === "agents"
                        ? sortDir === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <SortHeader
                      label="Agents"
                      active={sortKey === "agents"}
                      dir={sortDir}
                      onClick={() => toggleSort("agents")}
                    />
                  </th>
                  <th scope="col">Status</th>
                  <th scope="col">Chain</th>
                  <th scope="col" style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {pagedSyndicates.map((s, i) => {
                  const badge = CHAIN_BADGES[s.chainId];
                  const statusMeta = STATUS_COLORS[s.status] || STATUS_COLORS.IDLE;
                  // Absolute rank index — page offset + position in current page
                  const rankIdx = safePage * PAGE_SIZE + i;
                  const watchKey = `${s.chainId}:${s.id}`;
                  const rowKey = `${s.chainId}-${s.id}`;
                  const isFlashed = flashedKey === rowKey;
                  return (
                    <tr
                      key={rowKey}
                      ref={(el) => {
                        if (el) rowRefs.current.set(rowKey, el);
                        else rowRefs.current.delete(rowKey);
                      }}
                      className={`${rankIdx === 0 ? "lb-row-top1 " : ""}${isFlashed ? "lb-row-flash" : ""}`.trim() || undefined}
                    >
                      <td>
                        <StarButton
                          active={watchlist.has(watchKey)}
                          onClick={() => watchlist.toggle(watchKey)}
                          label={s.name}
                        />
                      </td>
                      <td><RankCell index={rankIdx} delta={rankDeltas[rowKey]} /></td>
                      <td>
                        <Link
                          href={`/syndicate/${s.subdomain}`}
                          className="text-white font-medium no-underline hover:text-[var(--color-accent)] transition-colors"
                        >
                          {s.name}
                        </Link>
                        <NewBadge ageDays={s.ageDays} />
                        <span
                          className="block mt-0.5"
                          style={{ color: "rgba(255,255,255,0.3)", fontSize: "11px" }}
                        >
                          {s.subdomain}.sherwoodagent.eth
                        </span>
                      </td>
                      <td style={{ color: "rgba(255,255,255,0.6)", fontSize: "12px" }}>
                        {s.strategy || "—"}
                      </td>
                      <td className="apy-highlight">
                        {s.tvl}
                        {s.tvlUSDDisplay && !s.tvl.startsWith("$") && (
                          <span className="block mt-0.5" style={{ color: "rgba(255,255,255,0.35)", fontSize: "10px" }}>
                            ~{s.tvlUSDDisplay}
                          </span>
                        )}
                      </td>
                      <td>
                        {s.equityCurve && s.equityCurve.length > 1 ? (
                          <Sparkline
                            data={s.equityCurve}
                            width={80}
                            height={22}
                            ariaLabel={`7-day TVL trajectory for ${s.name}`}
                          />
                        ) : (
                          <span style={{ color: "rgba(255,255,255,0.2)" }}>—</span>
                        )}
                      </td>
                      <td><FlowTrend trend={s.flowTrend} /></td>
                      <td>{s.agentCount}</td>
                      <td>
                        <span
                          style={{
                            background: statusMeta.bg,
                            color: statusMeta.text,
                            padding: "2px 8px",
                            borderRadius: "3px",
                            fontSize: "10px",
                            fontWeight: 600,
                            letterSpacing: "0.05em",
                          }}
                        >
                          {statusMeta.label.toUpperCase()}
                        </span>
                      </td>
                      <td>
                        {badge && (
                          <Badge variant="info">{badge.label}</Badge>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link href={`/syndicate/${s.subdomain}`} className="btn-follow">
                          [ VIEW ]
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Pagination footer */}
          {filteredSyndicates.length > PAGE_SIZE && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "0.85rem 1rem",
                borderTop: "1px solid var(--color-border-soft)",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--color-fg-secondary)",
                letterSpacing: "0.1em",
              }}
            >
              <span>
                {safePage * PAGE_SIZE + 1}
                {"–"}
                {Math.min((safePage + 1) * PAGE_SIZE, filteredSyndicates.length)}{" "}
                of {filteredSyndicates.length}
              </span>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <button
                  type="button"
                  className="sh-btn sh-btn--secondary sh-btn--sm"
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                >
                  ← Prev
                </button>
                <span style={{ padding: "0 0.5rem" }}>
                  Page {safePage + 1} / {totalPages}
                </span>
                <button
                  type="button"
                  className="sh-btn sh-btn--secondary sh-btn--sm"
                  onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage >= totalPages - 1}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Agents tab */}
      {tab === "agents" && (
        <div className="table-container" style={{ borderTop: "none" }}>
          {filteredAgents.length === 0 ? (
            <EmptyState
              icon="Q.00"
              title={agents.length === 0 ? "No registered agents yet" : "No matching agents"}
              description={
                agents.length === 0
                  ? "Agents are minted through the Agent0 SDK and then register with a syndicate."
                  : "Adjust your search or chain filter to see more."
              }
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col" style={{ width: "40px" }}>#</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Syndicate</th>
                  <th scope="col">Strategies</th>
                  <th scope="col">P&L</th>
                  <th scope="col">Chain</th>
                  <th scope="col" style={{ textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredAgents.map((a, i) => {
                  const badge = CHAIN_BADGES[a.chainId];
                  return (
                    <tr key={`${a.agentAddress}-${a.syndicateSubdomain}`} className={i === 0 ? "lb-row-top1" : undefined}>
                      <td><RankCell index={i} /></td>
                      <td>
                        <span className="text-white font-medium">
                          {a.agentName || truncateAddress(a.agentAddress)}
                        </span>
                        <span
                          className="block mt-0.5"
                          style={{
                            color: a.agentName ? "rgba(255,255,255,0.3)" : "var(--color-accent)",
                            fontSize: "10px",
                            opacity: a.agentName ? 1 : 0.7,
                          }}
                        >
                          {a.agentName
                            ? `${truncateAddress(a.agentAddress)} · ERC-8004 #${a.agentId}`
                            : `ERC-8004 #${a.agentId}`}
                        </span>
                      </td>
                      <td>
                        <Link
                          href={`/syndicate/${a.syndicateSubdomain}`}
                          className="text-white font-medium no-underline hover:text-[var(--color-accent)] transition-colors"
                        >
                          {a.syndicateName}
                        </Link>
                        <span
                          className="block mt-0.5"
                          style={{ color: "rgba(255,255,255,0.3)", fontSize: "11px" }}
                        >
                          {a.syndicateSubdomain}.sherwoodagent.eth
                        </span>
                      </td>
                      <td>{a.proposalCount}</td>
                      <td>
                        <PnlDelta value={a.totalPnl} raw={a.totalPnlRaw} />
                      </td>
                      <td>
                        {badge && <Badge variant="info">{badge.label}</Badge>}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Link href={`/syndicate/${a.syndicateSubdomain}/agents`} className="btn-follow">
                          [ VIEW AGENT ]
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

interface FilterDropdownProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}

function FilterDropdown({ label, value, onChange, options }: FilterDropdownProps) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "10px",
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "var(--color-fg-secondary)",
        }}
      >
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="sh-input"
        style={{ minWidth: "140px", padding: "0.5rem 0.75rem", fontSize: "12px", minHeight: "36px" }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}
