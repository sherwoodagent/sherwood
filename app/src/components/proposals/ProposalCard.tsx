import { type Address } from "viem";
import {
  type ProposalData,
  type GovernorParams,
  ProposalState,
  formatTimeRemaining,
} from "@/lib/governor-data";
import { truncateAddress, formatUSDC, formatBps } from "@/lib/contracts";
import VoteButton from "./VoteButton";

interface ProposalCardProps {
  proposal: ProposalData;
  governorAddress: Address;
  params: GovernorParams;
}

export default function ProposalCard({
  proposal,
  governorAddress,
  params,
}: ProposalCardProps) {
  const title =
    proposal.metadata?.title || `Proposal #${proposal.id.toString()}`;
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
              fontFamily: "var(--font-jetbrains-mono), monospace",
            }}
          >
            by {truncateAddress(proposal.proposer)} · Fee:{" "}
            {formatBps(proposal.performanceFeeBps)} ·{" "}
            {isPending ? "Voting" : "Execution"}: {deadline > 0n ? formatTimeRemaining(deadline) : "—"}
          </div>
        </div>
        <span
          className="glitch-tag"
          style={
            isApproved
              ? { background: "rgba(45,212,45,0.2)", color: "var(--color-accent)" }
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
            {/* Quorum marker */}
            <div
              className="vote-progress-quorum"
              style={{ left: `${Number(params.quorumBps) / 100}%` }}
              title={`Quorum: ${formatBps(params.quorumBps)}`}
            />
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "10px",
              fontFamily: "var(--font-jetbrains-mono), monospace",
              color: "rgba(255,255,255,0.4)",
              marginTop: "4px",
            }}
          >
            <span style={{ color: "var(--color-accent)" }}>
              FOR {forPct.toFixed(1)}%
            </span>
            <span>
              {formatUSDC(totalVotes)} total votes
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
            fontFamily: "var(--font-jetbrains-mono), monospace",
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
