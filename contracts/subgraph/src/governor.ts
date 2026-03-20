import { BigInt } from "@graphprotocol/graph-ts";
import {
  ProposalCreated,
  VoteCast,
  ProposalExecuted,
  ProposalSettled,
  ProposalCancelled,
  AgentSettled,
  EmergencySettled,
} from "../generated/SyndicateGovernor/SyndicateGovernor";
import { Proposal, Vote, VaultLookup } from "../generated/schema";

/**
 * Resolve syndicateId from a vault address using the VaultLookup entity
 * created in factory.ts when a syndicate is created.
 */
function getSyndicateIdFromVault(vaultAddress: string): string | null {
  let lookup = VaultLookup.load(vaultAddress);
  if (lookup == null) return null;
  return lookup.syndicate;
}

// ── Proposal Lifecycle ──

export function handleProposalCreated(event: ProposalCreated): void {
  let proposalId = event.params.proposalId.toString();
  let vaultAddress = event.params.vault.toHexString();
  let syndicateId = getSyndicateIdFromVault(vaultAddress);

  // Skip if vault isn't tracked (shouldn't happen, but be defensive)
  if (syndicateId == null) return;

  let proposal = new Proposal(proposalId);

  proposal.syndicate = syndicateId!;
  proposal.vault = event.params.vault;
  proposal.proposer = event.params.proposer;
  proposal.performanceFeeBps = event.params.performanceFeeBps;
  proposal.strategyDuration = event.params.strategyDuration;
  proposal.splitIndex = event.params.splitIndex;
  proposal.callCount = event.params.callCount;
  proposal.metadataURI = event.params.metadataURI;
  proposal.state = "Pending";
  proposal.capitalSnapshot = null;
  proposal.finalPnl = null;
  proposal.performanceFee = null;
  proposal.createdAt = event.block.timestamp;
  proposal.executedAt = null;
  proposal.settledAt = null;
  proposal.txHash = event.transaction.hash;

  proposal.save();
}

export function handleVoteCast(event: VoteCast): void {
  let proposalId = event.params.proposalId.toString();
  let voterId = event.params.voter.toHexString();

  let id = proposalId + "-" + voterId;
  let vote = new Vote(id);

  vote.proposal = proposalId;
  vote.voter = event.params.voter;
  vote.support = event.params.support;
  vote.weight = event.params.weight;
  vote.timestamp = event.block.timestamp;
  vote.txHash = event.transaction.hash;

  vote.save();
}

export function handleProposalExecuted(event: ProposalExecuted): void {
  let proposalId = event.params.proposalId.toString();
  let proposal = Proposal.load(proposalId);
  if (proposal == null) return;

  proposal.state = "Executed";
  proposal.capitalSnapshot = event.params.capitalSnapshot;
  proposal.executedAt = event.block.timestamp;

  proposal.save();
}

export function handleProposalSettled(event: ProposalSettled): void {
  let proposalId = event.params.proposalId.toString();
  let proposal = Proposal.load(proposalId);
  if (proposal == null) return;

  proposal.state = "Settled";
  proposal.finalPnl = event.params.pnl;
  proposal.performanceFee = event.params.performanceFee;
  proposal.settledAt = event.block.timestamp;

  proposal.save();
}

export function handleProposalCancelled(event: ProposalCancelled): void {
  let proposalId = event.params.proposalId.toString();
  let proposal = Proposal.load(proposalId);
  if (proposal == null) return;

  proposal.state = "Cancelled";

  proposal.save();
}

export function handleAgentSettled(event: AgentSettled): void {
  let proposalId = event.params.proposalId.toString();
  let proposal = Proposal.load(proposalId);
  if (proposal == null) return;

  proposal.state = "Settled";
  proposal.finalPnl = event.params.pnl;
  proposal.performanceFee = event.params.performanceFee;
  proposal.settledAt = event.block.timestamp;

  proposal.save();
}

export function handleEmergencySettled(event: EmergencySettled): void {
  let proposalId = event.params.proposalId.toString();
  let proposal = Proposal.load(proposalId);
  if (proposal == null) return;

  proposal.state = "Settled";
  proposal.finalPnl = event.params.pnl;
  proposal.settledAt = event.block.timestamp;

  proposal.save();
}
