import { type Address } from "viem";
import {
  type ProposalData,
  type GovernorParams,
  ProposalState,
  formatTimeRemaining,
} from "@/lib/governor-data";
import { truncateAddress, formatBps, formatShares } from "@/lib/contracts";
import VoteButton from "./VoteButton";
import ExecutionCallPreview from "./ExecutionCallPreview";
import VoteConcentration from "./VoteConcentration";
import { ProposalStepper } from "@/components/ui/ProposalStepper";

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
  const title =
    proposal.metadata?.title || `Proposal #${proposal.id.toString()}`;
  const description = proposal.metadata?.description?.trim() || "";
  const truncatedDescription =
    description.length > 180 ? `${description.slice(0, 177)}...` : description;
  const totalVotes = proposal.votesFor + proposal.votesAgainst;
  const forPct =
    totalVotes > 0n
      ? Number((proposal.votesFor * 10000n) / totalVotes) / 100
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
    <div className="prop-card">
      {/* Left ID rail */}
      <div className="prop-card__id">
        <span className="prop-card__id-label">Prop</span>
        <span className="prop-card__id-num">#{idStr}</span>
      </div>

      {/* Body */}
      <div>
        <div className="prop-card__head">
          <div style={{ minWidth: 0 }}>
            <div className="prop-card__title">{title}</div>
            <div className="prop-card__meta">
              <span>
                <span className="prop-card__meta-key">By</span>
                <span className="prop-card__meta-val">{proposerLabel}</span>
              </span>
              <span>
                <span className="prop-card__meta-key">Fee</span>
                <span className="prop-card__meta-val">{formatBps(proposal.performanceFeeBps)}</span>
              </span>
              <span>
                <span className="prop-card__meta-key">{isPending ? "Voting" : "Execution"}</span>
                <span className="prop-card__meta-val">{timerLabel}</span>
              </span>
            </div>
            {truncatedDescription && (
              <div className="prop-card__desc font-[family-name:var(--font-plus-jakarta)]">
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
          <div className="prop-card__vote">
            <div className="prop-card__vote-numbers">
              <span className="prop-card__vote-pct prop-card__vote-pct--for">
                {forPct.toFixed(1)}%
              </span>
              <span className="prop-card__vote-divider">/</span>
              <span className="prop-card__vote-pct prop-card__vote-pct--against">
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
            <div className="prop-card__vote-foot">
              <span style={{ color: "var(--color-accent)" }}>For</span>
              <span>
                {formatShares(totalVotes, assetDecimals * 2)} shares · Veto ≥ {formatBps(params.vetoThresholdBps)}
              </span>
              <span style={{ color: "#ff4d4d" }}>Against</span>
            </div>
          </div>
        ) : (
          <div className="prop-card__no-votes">{"// No Votes Yet"}</div>
        )}

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
              <div className="prop-card__demo-notice" role="note">
                Demo mode — voting disabled. Connect a live syndicate to participate.
              </div>
            ) : (
              <VoteButton
                governorAddress={governorAddress}
                proposalId={proposal.id}
                voteEnd={proposal.voteEnd}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
