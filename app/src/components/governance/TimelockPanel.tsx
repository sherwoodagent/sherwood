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

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Address } from "viem";
import { SYNDICATE_GOVERNOR_ABI } from "@/lib/contracts";
import { Countdown } from "@/components/ui/Countdown";
import { Term } from "@/components/ui/Glossary";

const QUEUED_EVENT = parseAbiItem(
  "event ParameterChangeQueued(bytes32 indexed paramKey, uint256 newValue, uint256 effectiveAt)",
);

const BLOCK_WINDOW = 60_000n;

interface PendingChange {
  paramKey: `0x${string}`;
  label: string;
  newValue: bigint;
  /** Timestamp after which the change can be finalized. */
  effectiveAt: bigint;
}

interface Props {
  governorAddress: Address;
  chainId: number;
}

/** keccak256 of parameter names from GovernorParameters.sol, computed via
 *  `cast keccak "votingPeriod"` etc. Maps paramKey → human label. */
const PARAM_LABELS: Record<string, string> = {
  "0x76f733d2535ffde0b80d69adaccb5c2fb7ee34b4cd295def21acc7430f9cd824": "Voting Period",
  "0xa4b5f6bf28c085260904fae0b08985850e712a3a7a8c2878d270d9553a57b21f": "Execution Window",
  "0xa4f81ccb2354204c9f162b42b0cd6586b02247e3ac18e6f88a746ca444e65557": "Veto Threshold",
  "0x99d950da57e425332e0f1cec408ed3b99b2af0b63a2065a8fb14ea8b71c75789": "Max Performance Fee",
  "0xcce1092625a03fac0d6e8157338acd93b25b81ceea4c4e6d9ad09c18cd5f8fad": "Min Strategy Duration",
  "0x305f0386aba27545cda71d8e4dc09dc19364bf2899ad2a7993763819e6212558": "Max Strategy Duration",
  "0x293cb597f24591d5414f6e271e5de3fa4bbd9c27f749b4efbb561e3643e8e23b": "Cooldown Period",
  "0x233e14d086be76b44a8127f5a05ce665a37d62bec45665208b0d2e5fd2c8724c": "Collaboration Window",
  "0x413fb89725373d2e7f4001d903c8b479ed4fb543bdf153f24cee2969efd118e0": "Max Co-Proposers",
  "0x01b466362d07312faeacb71469058a46b31266e91b12cf581791bf051d79b0e2": "Protocol Fee",
};

/** Keys that represent basis-point values (displayed as X.Y%). */
const BPS_PARAMS = new Set([
  "0xa4f81ccb2354204c9f162b42b0cd6586b02247e3ac18e6f88a746ca444e65557", // vetoThresholdBps
  "0x99d950da57e425332e0f1cec408ed3b99b2af0b63a2065a8fb14ea8b71c75789", // maxPerformanceFeeBps
  "0x01b466362d07312faeacb71469058a46b31266e91b12cf581791bf051d79b0e2", // protocolFeeBps
]);

/** Keys that represent durations in seconds. */
const DURATION_PARAMS = new Set([
  "0x76f733d2535ffde0b80d69adaccb5c2fb7ee34b4cd295def21acc7430f9cd824", // votingPeriod
  "0xa4b5f6bf28c085260904fae0b08985850e712a3a7a8c2878d270d9553a57b21f", // executionWindow
  "0xcce1092625a03fac0d6e8157338acd93b25b81ceea4c4e6d9ad09c18cd5f8fad", // minStrategyDuration
  "0x305f0386aba27545cda71d8e4dc09dc19364bf2899ad2a7993763819e6212558", // maxStrategyDuration
  "0x293cb597f24591d5414f6e271e5de3fa4bbd9c27f749b4efbb561e3643e8e23b", // cooldownPeriod
  "0x233e14d086be76b44a8127f5a05ce665a37d62bec45665208b0d2e5fd2c8724c", // collaborationWindow
]);

/** Format a raw newValue into a human-friendly display. */
function formatParamValue(paramKey: string, raw: bigint): string {
  if (BPS_PARAMS.has(paramKey)) {
    return `${(Number(raw) / 100).toFixed(1)}%`;
  }
  if (DURATION_PARAMS.has(paramKey)) {
    const secs = Number(raw);
    if (secs >= 86400) return `${(secs / 86400).toFixed(1)}d`;
    if (secs >= 3600) return `${(secs / 3600).toFixed(1)}h`;
    return `${(secs / 60).toFixed(0)}m`;
  }
  return raw.toString();
}

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
        // The function is `getPendingChange` (not getPendingParameterChange)
        // and returns { newValue, effectiveAt, exists }.
        const checks = await client.multicall({
          contracts: candidates.map((c) => ({
            address: governorAddress,
            abi: SYNDICATE_GOVERNOR_ABI,
            functionName: "getPendingChange" as const,
            args: [c.args.paramKey as `0x${string}`] as const,
          })),
        });

        const out: PendingChange[] = [];
        for (let i = 0; i < candidates.length; i++) {
          const r = checks[i];
          if (r.status !== "success" || !r.result) continue;
          const data = r.result as { newValue: bigint; effectiveAt: bigint; exists: boolean };
          // exists == false means no pending change (finalized or cancelled).
          if (!data.exists || !data.effectiveAt || data.effectiveAt === 0n) continue;
          const paramKey = candidates[i].args.paramKey as `0x${string}`;
          out.push({
            paramKey,
            label: labelFor(paramKey),
            newValue: data.newValue,
            effectiveAt: data.effectiveAt,
          });
        }

        if (!cancelled) {
          setPending(out);
          setLoading(false);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[TimelockPanel] could not read parameter changes", err);
        if (!cancelled) {
          setErrored(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [client, governorAddress, chainId]);

  // Render the panel ONLY when there's a real pending change. The panel
  // is an exception surface — if everything's settled (or the governor on
  // this chain doesn't emit timelock events), we render nothing rather
  // than blare an empty/error placeholder. The errored case is logged in
  // the console for debugging but not surfaced as UI noise.
  if (loading) return null;
  if (errored) return null;
  if (pending.length === 0) return null;

  return (
    <div className="panel" style={{ marginTop: "1.5rem" }}>
      <div className="panel-title">
        <span>
          <Term k="optimistic-governance">Pending Parameter Changes</Term>
        </span>
        <span style={{ color: "var(--color-fg-secondary)", fontSize: "10px" }}>
          {pending.length}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        {pending.map((p) => (
          <ChangeRow key={p.paramKey} change={p} />
        ))}
      </div>
    </div>
  );
}

function ChangeRow({ change }: { change: PendingChange }) {
  // Tick every second so the "ready" transition reflects live without a
  // page reload. Light-weight — one timer per pending change row, and
  // pending changes are an exceptional surface (rarely > 1).
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const ready = change.effectiveAt <= BigInt(now);
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
          <span style={{ color: "var(--color-accent)", marginLeft: "0.5rem" }}>
            → {formatParamValue(change.paramKey, change.newValue)}
          </span>
        </div>
        {ready ? (
          <span className="sh-badge sh-badge--success">Ready to finalize</span>
        ) : (
          <Countdown to={change.effectiveAt} label="Finalize in" />
        )}
      </div>
      <div className="sh-stepper">
        {/* Queued is always in the past. */}
        <div className="sh-stepper__node sh-stepper__node--done">
          <div className="sh-stepper__dot">✓</div>
          <div className="sh-stepper__label">Queued</div>
        </div>
        <div
          className={`sh-stepper__connector ${ready ? "sh-stepper__connector--done" : ""}`}
        />
        {/* Delay is active while we're waiting; done once the timelock elapses. */}
        <div
          className={`sh-stepper__node ${ready ? "sh-stepper__node--done" : "sh-stepper__node--active"}`}
        >
          <div className="sh-stepper__dot">{ready ? "✓" : "2"}</div>
          <div className="sh-stepper__label">Delay</div>
        </div>
        <div
          className={`sh-stepper__connector ${ready ? "sh-stepper__connector--done" : ""}`}
        />
        {/* Finalized is the next required action once the delay clears. */}
        <div
          className={`sh-stepper__node ${ready ? "sh-stepper__node--active" : ""}`}
        >
          <div className="sh-stepper__dot">3</div>
          <div className="sh-stepper__label">Finalized</div>
        </div>
      </div>
    </div>
  );
}
