"use client";

/**
 * VoteConcentration — aggregates VoteCast logs for a proposal and renders the
 * top voters with their share. Helps LPs see whether veto power is in one
 * wallet or distributed.
 *
 * Reads logs via viem's getLogs. Bounded to a recent block window (last
 * ~50k blocks ≈ 7d on Base) for cost — for older proposals this returns
 * "—" rather than an empty list.
 */

import { useEffect, useState } from "react";
import { usePublicClient } from "wagmi";
import { parseAbiItem, type Address, formatUnits } from "viem";
import { truncateAddress } from "@/lib/contracts";
import { Term } from "@/components/ui/Glossary";

const VOTE_CAST_EVENT = parseAbiItem(
  "event VoteCast(uint256 indexed proposalId, address indexed voter, uint8 support, uint256 weight)",
);

interface VoteConcentrationProps {
  governorAddress: Address;
  proposalId: bigint;
  chainId: number;
  /** Vault decimals. Shares use decimals * 2 (ERC-4626 inflation guard). */
  assetDecimals: number;
  /** Map of address → display name from agent identities. */
  addressNames?: Record<string, string>;
}

interface VoterRow {
  voter: Address;
  weight: bigint;
  support: number;
  share: number; // 0..1
}

const BLOCK_WINDOW = 60_000n; // ~7d on Base (2s blocks)

export default function VoteConcentration({
  governorAddress,
  proposalId,
  chainId,
  assetDecimals,
  addressNames,
}: VoteConcentrationProps) {
  const client = usePublicClient({ chainId });
  const [rows, setRows] = useState<VoterRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!client) return;

    (async () => {
      try {
        setLoading(true);
        setErrored(false);
        const head = await client.getBlockNumber();
        const fromBlock = head > BLOCK_WINDOW ? head - BLOCK_WINDOW : 0n;
        const logs = await client.getLogs({
          address: governorAddress,
          event: VOTE_CAST_EVENT,
          args: { proposalId },
          fromBlock,
          toBlock: head,
        });

        // Aggregate by voter (last vote wins per voter — governors disallow
        // re-voting but we sum defensively in case of test-net oddities).
        const byVoter = new Map<Address, { weight: bigint; support: number }>();
        for (const log of logs) {
          const voter = log.args.voter as Address;
          const weight = (log.args.weight as bigint) ?? 0n;
          const support = Number(log.args.support ?? 0);
          byVoter.set(voter, { weight, support });
        }

        const total = Array.from(byVoter.values()).reduce(
          (s, v) => s + v.weight,
          0n,
        );

        const list: VoterRow[] = Array.from(byVoter.entries())
          .map(([voter, v]) => ({
            voter,
            weight: v.weight,
            support: v.support,
            share:
              total === 0n
                ? 0
                : Number((v.weight * 10000n) / total) / 10000,
          }))
          .sort((a, b) => Number(b.weight - a.weight))
          .slice(0, 5);

        if (!cancelled) {
          setRows(list);
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
  }, [client, governorAddress, proposalId]);

  return (
    <details className="exec-preview">
      <summary className="exec-preview__summary">
        <span className="exec-preview__label">
          <Term k="veto-threshold">Vote concentration</Term>
        </span>
        <span className="exec-preview__count">
          {loading
            ? "loading…"
            : errored
              ? "unavailable"
              : rows && rows.length > 0
                ? `top ${rows.length}`
                : "no votes yet"}
        </span>
      </summary>
      {!loading && !errored && rows && rows.length > 0 && (
        <div className="exec-preview__body">
          <div
            style={{
              fontSize: 11,
              color: "var(--color-fg-secondary)",
              marginBottom: "0.5rem",
            }}
          >
            Voter weights as a share of total cast votes. Concentration ≥ 50%
            in a single wallet means one LP can swing the outcome.
          </div>
          {rows.map((r) => {
            const label =
              addressNames?.[r.voter.toLowerCase()] || truncateAddress(r.voter);
            const supportColor =
              r.support === 0
                ? "var(--color-accent)"
                : r.support === 1
                  ? "#ff4d4d"
                  : "rgba(255,255,255,0.5)";
            const supportLabel =
              r.support === 0 ? "FOR" : r.support === 1 ? "AGAINST" : "ABSTAIN";
            return (
              <div
                key={r.voter}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 60px 80px 60px",
                  gap: "0.75rem",
                  padding: "0.5rem 0",
                  alignItems: "center",
                  borderBottom: "1px solid var(--color-border-soft)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "var(--color-fg)" }}>{label}</span>
                <span style={{ color: supportColor, fontSize: 10, letterSpacing: "0.1em" }}>
                  {supportLabel}
                </span>
                <span style={{ color: "var(--color-fg-secondary)", fontSize: 11 }}>
                  {parseFloat(formatUnits(r.weight, assetDecimals * 2)).toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}
                </span>
                <span
                  style={{
                    color: r.share >= 0.5 ? "#ff4d4d" : "var(--color-fg)",
                    fontSize: 11,
                    textAlign: "right",
                    fontWeight: 600,
                  }}
                >
                  {(r.share * 100).toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      )}
      {!loading && errored && (
        <div className="exec-preview__empty">
          Could not read VoteCast logs (RPC error or block-range limit).
        </div>
      )}
      {!loading && !errored && rows && rows.length === 0 && (
        <div className="exec-preview__empty">
          No votes cast yet — or the proposal predates our 7d log scan window.
        </div>
      )}
    </details>
  );
}
