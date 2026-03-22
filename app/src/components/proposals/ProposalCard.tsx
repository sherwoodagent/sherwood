import { type Address } from "viem";
import {
  type ProposalData,
  type GovernorParams,
  ProposalState,
  formatTimeRemaining,
} from "@/lib/governor-data";
import { truncateAddress, formatBps, formatShares } from "@/lib/contracts";
import VoteButton from "./VoteButton";

interface ProposalCardProps {
  proposal: ProposalData;
  governorAddress: Address;
  params: GovernorParams;
  assetDecimals: number;
  addressNames?: Record<string, string>;
}

export default function ProposalCard({
  proposal,
  governorAddress,
  params,
  assetDecimals,
  addressNames,
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

  return (
    <div
      className="panel"
      style={{ marginBottom: "1rem" }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: "1rem",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "14px",
              color: "#fff",
              fontWeight: 500,
              marginBottom: "0.25rem",
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: "11px",
              color: "rgba(255,255,255,0.4)",
              fontFamily: "var(--font-plus-jakarta), sans-serif",
            }}
          >
            by {addressNames?.[proposal.proposer.toLowerCase()] || truncateAddress(proposal.proposer)} · Fee:{" "}
            {formatBps(proposal.performanceFeeBps)} ·{" "}
            {isPending ? "Voting" : "Execution"}: {deadline > 0n ? formatTimeRemaining(deadline) : "—"}
          </div>
          {truncatedDescription && (
            <div
              style={{
                marginTop: "0.5rem",
                fontSize: "12px",
                color: "rgba(255,255,255,0.7)",
                lineHeight: 1.4,
              }}
            >
              {truncatedDescription}
            </div>
          )}
        </div>
        <span
          className="glitch-tag"
          style={
            isApproved
              ? { background: "rgba(46,230,166,0.2)", color: "var(--color-accent)" }
              : undefined
          }
        >
          {isPending ? "VOTING" : "APPROVED"}
        </span>
      </div>

      {/* Vote progress bar */}
      {totalVotes > 0n ? (
        <div style={{ marginBottom: "1rem" }}>
          <div className="vote-progress-bar">
            <div
              className="vote-progress-for"
              style={{ width: `${forPct}%` }}
            />
            <div
              className="vote-progress-against"
              style={{ width: `${againstPct}%` }}
            />
            {/* Veto threshold marker removed — vetoThresholdBps is % of total supply,
                not % of votes cast. Shown as text below instead. */}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "10px",
              fontFamily: "var(--font-plus-jakarta), sans-serif",
              color: "rgba(255,255,255,0.4)",
              marginTop: "4px",
            }}
          >
            <span style={{ color: "var(--color-accent)" }}>
              FOR {forPct.toFixed(1)}%
            </span>
            <span>
              {formatShares(totalVotes, assetDecimals * 2)} shares voted · Veto Threshold: {formatBps(params.vetoThresholdBps)}
            </span>
            <span style={{ color: "#ff4d4d" }}>
              {againstPct.toFixed(1)}% AGAINST
            </span>
          </div>
        </div>
      ) : (
        <div
          style={{
            marginBottom: "1rem",
            fontSize: "11px",
            color: "rgba(255,255,255,0.3)",
            fontFamily: "var(--font-plus-jakarta), sans-serif",
          }}
        >
          No votes yet
        </div>
      )}

      {isPending && (
        <VoteButton
          governorAddress={governorAddress}
          proposalId={proposal.id}
          voteEnd={proposal.voteEnd}
        />
      )}
    </div>
  );
}
