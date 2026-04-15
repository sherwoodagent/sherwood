"use client";

import { useState } from "react";
import { type Address } from "viem";
import {
  type ProposalData,
  type GovernorParams,
  ProposalState,
  formatTimeRemaining,
} from "@/lib/governor-data";
import { truncateAddress, formatBps, formatShares, shareDecimals } from "@/lib/contracts";
import VoteButton from "./VoteButton";
import ExecutionCallPreview from "./ExecutionCallPreview";
import SwapRiskWarning from "./SwapRiskWarning";
import VoteConcentration from "./VoteConcentration";
import { ProposalStepper } from "@/components/ui/ProposalStepper";

/**
 * Optimistic vote state — added to the on-chain count between tx submit
 * and tx receipt. Cleared on confirmed (a router.refresh follows) or on
 * error (so we don't keep a phantom vote in the bar).
 */
export interface OptimisticVote {
  weight: bigint;
  support: 0 | 1; // 0 = FOR, 1 = AGAINST
}

interface ProposalCardProps {
  proposal: ProposalData;
  governorAddress: Address;
  params: GovernorParams;
  assetDecimals: number;
  addressNames?: Record<string, string>;
  /** When true, voting UI is replaced with a demo-mode notice. */
  disabled?: boolean;
  /** When provided, renders execution-call preview (chainId + explorer URL). */
  chainId?: number;
  explorerUrl?: string;
}

export default function ProposalCard({
  proposal,
  governorAddress,
  params,
  assetDecimals,
  addressNames,
  disabled = false,
  chainId,
  explorerUrl,
}: ProposalCardProps) {
  const [optimistic, setOptimistic] = useState<OptimisticVote | null>(null);

  const title =
    proposal.metadata?.title || `Proposal #${proposal.id.toString()}`;
  const description = proposal.metadata?.description?.trim() || "";
  const truncatedDescription =
    description.length > 180 ? `${description.slice(0, 177)}...` : description;

  // Apply optimistic delta to the on-chain numbers so the vote bar updates
  // instantly on submit. The actual chain values get re-fetched on
  // router.refresh() after the tx confirms; we then drop the optimistic
  // overlay (handled by VoteButton's onConfirm callback below).
  const votesFor =
    proposal.votesFor + (optimistic?.support === 0 ? optimistic.weight : 0n);
  const votesAgainst =
    proposal.votesAgainst + (optimistic?.support === 1 ? optimistic.weight : 0n);
  const totalVotes = votesFor + votesAgainst;
  const forPct =
    totalVotes > 0n
      ? Number((votesFor * 10000n) / totalVotes) / 100
      : 0;
  const againstPct = totalVotes > 0n ? 100 - forPct : 0;

  const isPending = proposal.computedState === ProposalState.Pending;
  const isApproved = proposal.computedState === ProposalState.Approved;

  const deadline = isPending
    ? proposal.voteEnd
    : isApproved
      ? proposal.executeBy
      : 0n;

  const proposerLabel =
    addressNames?.[proposal.proposer.toLowerCase()] ||
    truncateAddress(proposal.proposer);
  const timerLabel =
    deadline > 0n ? formatTimeRemaining(deadline) : "—";
  const idStr = String(proposal.id).padStart(2, "0");

  return (
    <div className="sh-card--prop">
      {/* Left ID rail */}
      <div className="sh-card--prop__id">
        <span className="sh-card--prop__id-label">Prop</span>
        <span className="sh-card--prop__id-num">#{idStr}</span>
      </div>

      {/* Body */}
      <div>
        <div className="sh-card--prop__head">
          <div style={{ minWidth: 0 }}>
            <div className="sh-card--prop__title">{title}</div>
            <div className="sh-card--prop__meta">
              <span>
                <span className="sh-card--prop__meta-key">By</span>
                <span className="sh-card--prop__meta-val">{proposerLabel}</span>
              </span>
              <span>
                <span className="sh-card--prop__meta-key">Fee</span>
                <span className="sh-card--prop__meta-val">{formatBps(proposal.performanceFeeBps)}</span>
              </span>
              <span>
                <span className="sh-card--prop__meta-key">{isPending ? "Voting" : "Execution"}</span>
                <span className="sh-card--prop__meta-val">{timerLabel}</span>
              </span>
            </div>
            {truncatedDescription && (
              <div className="sh-card--prop__desc font-[family-name:var(--font-plus-jakarta)]">
                {truncatedDescription}
              </div>
            )}
          </div>
          <span
            className="tag-bracket"
            style={{
              flexShrink: 0,
              color: isApproved ? "var(--color-accent)" : "#eab308",
            }}
          >
            {isPending ? "Voting" : "Approved"}
          </span>
        </div>

        {/* Vote progress */}
        {totalVotes > 0n ? (
          <div className="sh-card--prop__vote">
            <div className="sh-card--prop__vote-numbers">
              <span className="sh-card--prop__vote-pct sh-card--prop__vote-pct--for">
                {forPct.toFixed(1)}%
              </span>
              <span className="sh-card--prop__vote-divider">/</span>
              <span className="sh-card--prop__vote-pct sh-card--prop__vote-pct--against">
                {againstPct.toFixed(1)}%
              </span>
            </div>
            <div className="vote-progress-bar">
              <div
                className="vote-progress-for"
                style={{ width: `${forPct}%` }}
              />
              <div
                className="vote-progress-against"
                style={{ width: `${againstPct}%` }}
              />
            </div>
            <div className="sh-card--prop__vote-foot">
              <span style={{ color: "var(--color-accent)" }}>For</span>
              <span>
                {formatShares(totalVotes, shareDecimals(assetDecimals))} shares · Veto ≥ {formatBps(params.vetoThresholdBps)}
              </span>
              <span style={{ color: "#ff4d4d" }}>Against</span>
            </div>
          </div>
        ) : (
          <div className="sh-card--prop__no-votes">{"// No Votes Yet"}</div>
        )}

        {/* Mobile: stack the optimistic vote bar text so percentages
            remain readable beside a narrow progress bar. Handled via CSS
            class on .sh-card--prop__vote (globals.css).  */}

        {/* Proposal state stepper */}
        <div style={{ marginTop: "0.75rem", marginBottom: "0.5rem" }}>
          <ProposalStepper state={proposal.computedState} />
        </div>

        {/* Execution plan + vote concentration — live syndicates only */}
        {!disabled && chainId && explorerUrl && (
          <>
            <ExecutionCallPreview
              governorAddress={governorAddress}
              proposalId={proposal.id}
              chainId={chainId}
              explorerUrl={explorerUrl}
            />
            <SwapRiskWarning
              governorAddress={governorAddress}
              proposalId={proposal.id}
              chainId={chainId}
            />
            <VoteConcentration
              governorAddress={governorAddress}
              proposalId={proposal.id}
              chainId={chainId}
              assetDecimals={assetDecimals}
              addressNames={addressNames}
            />
          </>
        )}

        {isPending && (
          <div style={{ marginTop: "1rem" }}>
            {disabled ? (
              <div className="sh-card--prop__demo-notice" role="note">
                Demo mode — voting disabled. Connect a live syndicate to participate.
              </div>
            ) : (
              <VoteButton
                governorAddress={governorAddress}
                proposalId={proposal.id}
                voteEnd={proposal.voteEnd}
                onOptimistic={(weight, support) =>
                  setOptimistic({ weight, support })
                }
                onResolved={() => setOptimistic(null)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
