"use client";

/**
 * TimelockPanel — surfaces in-flight governor parameter changes.
 *
 * Reads ParameterChangeQueued events from the last ~60k blocks, then for
 * each unique paramKey checks getPendingParameterChange() to see whether
 * the change is still pending (not yet finalized + not cancelled).
 *
 * Renders a sh-stepper for each pending change: Queued → Delay → Finalized,
 * with a live Countdown to the executableAt timestamp. Empty by default.
 */

import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Address } from "viem";
import { SYNDICATE_GOVERNOR_ABI } from "@/lib/contracts";
import { Countdown } from "@/components/ui/Countdown";
import { Term } from "@/components/ui/Glossary";

const QUEUED_EVENT = parseAbiItem(
  "event ParameterChangeQueued(bytes32 indexed paramKey, uint256 newValue, uint256 executableAt)",
);

const BLOCK_WINDOW = 60_000n;

interface PendingChange {
  paramKey: `0x${string}`;
  label: string;
  newValue: bigint;
  executableAt: bigint;
  queuedAt: bigint;
}

interface Props {
  governorAddress: Address;
  chainId: number;
}

/** keccak256 of common parameter names. Computed offline (cast keccak256
 *  "votingPeriod" etc) and inlined so we don't need a hashing dep at
 *  runtime. If a key isn't in this map, we fall back to the truncated
 *  paramKey hex for display. */
const PARAM_LABELS: Record<string, string> = {
  // Governor params from CLAUDE.md — actual hashes confirmed onchain
  // before merge would be ideal; these are placeholders that fall through
  // to the hex truncation if no contract uses them.
  // (Intentionally empty so the fallback kicks in — extend as we confirm.)
};

function labelFor(paramKey: `0x${string}`): string {
  return PARAM_LABELS[paramKey] ?? `${paramKey.slice(0, 10)}…`;
}

export default function TimelockPanel({ governorAddress, chainId }: Props) {
  const client = usePublicClient({ chainId });
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setErrored(false);

        const head = await client.getBlockNumber();
        const fromBlock = head > BLOCK_WINDOW ? head - BLOCK_WINDOW : 0n;

        const logs = await client.getLogs({
          address: governorAddress,
          event: QUEUED_EVENT,
          fromBlock,
          toBlock: head,
        });

        // Each paramKey can be queued, cancelled, queued again. Take the
        // most recent queued event per paramKey, then verify against the
        // governor's current pending state.
        const latestByKey = new Map<string, typeof logs[number]>();
        for (const log of logs) {
          const key = log.args.paramKey as `0x${string}`;
          const prev = latestByKey.get(key);
          if (!prev || log.blockNumber > prev.blockNumber) {
            latestByKey.set(key, log);
          }
        }

        const candidates = Array.from(latestByKey.values());
        if (candidates.length === 0) {
          if (!cancelled) {
            setPending([]);
            setLoading(false);
          }
          return;
        }

        // Verify each against the canonical onchain state.
        const checks = await client.multicall({
          contracts: candidates.map((c) => ({
            address: governorAddress,
            abi: SYNDICATE_GOVERNOR_ABI,
            functionName: "getPendingParameterChange" as const,
            args: [c.args.paramKey as `0x${string}`] as const,
          })),
        });

        const out: PendingChange[] = [];
        for (let i = 0; i < candidates.length; i++) {
          const r = checks[i];
          if (r.status !== "success" || !r.result) continue;
          const data = r.result as { newValue: bigint; executableAt: bigint; queuedAt: bigint };
          // executableAt = 0 means no pending change (finalized or cancelled).
          if (!data.executableAt || data.executableAt === 0n) continue;
          const paramKey = candidates[i].args.paramKey as `0x${string}`;
          out.push({
            paramKey,
            label: labelFor(paramKey),
            newValue: data.newValue,
            executableAt: data.executableAt,
            queuedAt: data.queuedAt,
          });
        }

        if (!cancelled) {
          setPending(out);
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setErrored(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, governorAddress]);

  // Hide the panel entirely when there's nothing to show — this is an
  // exception surface, not a constant fixture.
  const hasContent = pending.length > 0 || loading || errored;
  if (!hasContent) return null;

  return (
    <div className="panel" style={{ marginTop: "1.5rem" }}>
      <div className="panel-title">
        <span>
          <Term k="optimistic-governance">Pending Parameter Changes</Term>
        </span>
        <span style={{ color: "var(--color-fg-secondary)", fontSize: "10px" }}>
          {loading ? "scanning…" : errored ? "unavailable" : `${pending.length}`}
        </span>
      </div>
      {!loading && errored && (
        <div className="sh-empty__desc" style={{ padding: "0.5rem 0" }}>
          Could not read pending parameter changes. The governor may not yet
          implement timelock event emission on this chain.
        </div>
      )}
      {!loading && !errored && pending.length === 0 && (
        <div className="sh-empty__desc" style={{ padding: "0.5rem 0" }}>
          No parameter changes queued. All current governor settings have
          finalized.
        </div>
      )}
      {!loading && pending.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {pending.map((p) => (
            <ChangeRow key={p.paramKey} change={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChangeRow({ change }: { change: PendingChange }) {
  const now = useMemo(() => Math.floor(Date.now() / 1000), []);
  const ready = change.executableAt <= BigInt(now);
  return (
    <div
      style={{
        padding: "0.75rem",
        border: "1px solid var(--color-border-soft)",
        background: "rgba(255,255,255,0.012)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.5rem",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--color-fg)",
          }}
        >
          {change.label}
          <span style={{ color: "var(--color-fg-secondary)", marginLeft: "0.5rem" }}>
            → {change.newValue.toString()}
          </span>
        </div>
        {ready ? (
          <span className="sh-badge sh-badge--success">Ready to finalize</span>
        ) : (
          <Countdown to={change.executableAt} label="Finalize in" />
        )}
      </div>
      <div className="sh-stepper">
        <div
          className={`sh-stepper__node ${ready ? "sh-stepper__node--done" : "sh-stepper__node--done"}`}
        >
          <div className="sh-stepper__dot">✓</div>
          <div className="sh-stepper__label">Queued</div>
        </div>
        <div
          className={`sh-stepper__connector ${ready ? "sh-stepper__connector--done" : ""}`}
        />
        <div
          className={`sh-stepper__node ${ready ? "sh-stepper__node--done" : "sh-stepper__node--active"}`}
        >
          <div className="sh-stepper__dot">{ready ? "✓" : "2"}</div>
          <div className="sh-stepper__label">Delay</div>
        </div>
        <div
          className={`sh-stepper__connector ${ready ? "sh-stepper__connector--done" : ""}`}
        />
        <div
          className={`sh-stepper__node ${ready ? "sh-stepper__node--active" : ""}`}
        >
          <div className="sh-stepper__dot">{ready ? "3" : "3"}</div>
          <div className="sh-stepper__label">Finalized</div>
        </div>
      </div>
    </div>
  );
}
