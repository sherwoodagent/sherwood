/**
 * Governor contract wrapper — reads/writes to SyndicateGovernor.
 *
 * Provides typed helpers for the proposal lifecycle, voting,
 * settlement, and parameter management.
 */

import type { Address, Hex } from "viem";
import { getPublicClient, getWalletClient, getAccount } from "./client.js";
import { getChain } from "./network.js";
import { SHERWOOD } from "./addresses.js";
import { SYNDICATE_GOVERNOR_ABI } from "./abis.js";

// ── Types ──

export interface GovernorParams {
  votingPeriod: bigint;
  executionWindow: bigint;
  quorumBps: bigint;
  maxPerformanceFeeBps: bigint;
  cooldownPeriod: bigint;
  collaborationWindow: bigint;
  maxCoProposers: bigint;
  minStrategyDuration: bigint;
  maxStrategyDuration: bigint;
}

export interface StrategyProposal {
  id: bigint;
  proposer: Address;
  vault: Address;
  metadataURI: string;
  performanceFeeBps: bigint;
  splitIndex: bigint;
  strategyDuration: bigint;
  votesFor: bigint;
  votesAgainst: bigint;
  votesAbstain: bigint;
  snapshotTimestamp: bigint;
  voteEnd: bigint;
  executeBy: bigint;
  executedAt: bigint;
  state: number;
}

export interface CoProposer {
  agent: Address;
  splitBps: bigint;
}

export interface BatchCall {
  target: Address;
  data: Hex;
  value: bigint;
}

export const PROPOSAL_STATES = [
  "Draft",
  "Pending",
  "Approved",
  "Rejected",
  "Expired",
  "Executed",
  "Settled",
  "Cancelled",
] as const;

export const PROPOSAL_STATE = {
  Draft: 0,
  Pending: 1,
  Approved: 2,
  Rejected: 3,
  Expired: 4,
  Executed: 5,
  Settled: 6,
  Cancelled: 7,
} as const;

export const VOTE_TYPE = {
  For: 0,
  Against: 1,
  Abstain: 2,
} as const;

// ── Duration parser ──

export function parseDuration(input: string): bigint {
  const match = input.match(/^(\d+)(d|h|m|s)?$/);
  if (!match) throw new Error(`Invalid duration: ${input}`);
  const value = BigInt(match[1]);
  switch (match[2]) {
    case "d":
      return value * 86400n;
    case "h":
      return value * 3600n;
    case "m":
      return value * 60n;
    case "s":
    case undefined:
      return value;
    default:
      throw new Error(`Unknown duration unit: ${match[2]}`);
  }
}

// ── Address helper ──

export function getGovernorAddress(): Address {
  return SHERWOOD().GOVERNOR;
}

// ── Read helpers ──

export async function getGovernorParams(): Promise<GovernorParams> {
  const client = getPublicClient();
  const result = await client.readContract({
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getGovernorParams",
  }) as {
    votingPeriod: bigint;
    executionWindow: bigint;
    quorumBps: bigint;
    maxPerformanceFeeBps: bigint;
    cooldownPeriod: bigint;
    collaborationWindow: bigint;
    maxCoProposers: bigint;
    minStrategyDuration: bigint;
    maxStrategyDuration: bigint;
  };
  return result;
}

export async function getProposal(id: bigint): Promise<StrategyProposal> {
  const client = getPublicClient();
  const result = await client.readContract({
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getProposal",
    args: [id],
  }) as {
    id: bigint;
    proposer: Address;
    vault: Address;
    metadataURI: string;
    performanceFeeBps: bigint;
    splitIndex: bigint;
    strategyDuration: bigint;
    votesFor: bigint;
    votesAgainst: bigint;
    votesAbstain: bigint;
    snapshotTimestamp: bigint;
    voteEnd: bigint;
    executeBy: bigint;
    executedAt: bigint;
    state: number;
  };
  return result;
}

export async function getProposalState(id: bigint): Promise<number> {
  const client = getPublicClient();
  return client.readContract({
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getProposalState",
    args: [id],
  }) as Promise<number>;
}

export async function proposalCount(): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "proposalCount",
  }) as Promise<bigint>;
}

export async function getVoteWeight(proposalId: bigint, voter: Address): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getVoteWeight",
    args: [proposalId, voter],
  }) as Promise<bigint>;
}

export async function hasVoted(proposalId: bigint, voter: Address): Promise<boolean> {
  const client = getPublicClient();
  return client.readContract({
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "hasVoted",
    args: [proposalId, voter],
  }) as Promise<boolean>;
}

export async function getProposalCalls(proposalId: bigint): Promise<BatchCall[]> {
  const client = getPublicClient();
  const result = await client.readContract({
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getProposalCalls",
    args: [proposalId],
  }) as { target: Address; data: Hex; value: bigint }[];
  return result.map((c) => ({ target: c.target, data: c.data, value: c.value }));
}

export async function getRegisteredVaults(): Promise<Address[]> {
  const client = getPublicClient();
  return client.readContract({
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getRegisteredVaults",
  }) as Promise<Address[]>;
}

export async function getActiveProposal(vault: Address): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getActiveProposal",
    args: [vault],
  }) as Promise<bigint>;
}

export async function getCooldownEnd(vault: Address): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getCooldownEnd",
    args: [vault],
  }) as Promise<bigint>;
}

export async function getCapitalSnapshot(proposalId: bigint): Promise<bigint> {
  const client = getPublicClient();
  return client.readContract({
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "getCapitalSnapshot",
    args: [proposalId],
  }) as Promise<bigint>;
}

export async function isRegisteredVault(vault: Address): Promise<boolean> {
  const client = getPublicClient();
  return client.readContract({
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "isRegisteredVault",
    args: [vault],
  }) as Promise<boolean>;
}

// ── Write helpers ──

export async function propose(
  vault: Address,
  metadataURI: string,
  performanceFeeBps: bigint,
  strategyDuration: bigint,
  calls: BatchCall[],
  splitIndex: bigint,
  coProposers: CoProposer[] = [],
): Promise<{ hash: Hex; proposalId: bigint }> {
  const wallet = getWalletClient();
  const client = getPublicClient();

  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "propose",
    args: [vault, metadataURI, performanceFeeBps, strategyDuration, calls, splitIndex, coProposers],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });

  // Parse proposalId from return value — use proposalCount as fallback
  let proposalId: bigint;
  try {
    proposalId = await proposalCount();
  } catch {
    proposalId = 0n;
  }

  return { hash: receipt.transactionHash, proposalId };
}

export async function vote(proposalId: bigint, support: number): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();

  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "vote",
    args: [proposalId, support],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}

export async function executeProposal(proposalId: bigint): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();

  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "executeProposal",
    args: [proposalId],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}

export async function settleProposal(proposalId: bigint): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();

  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "settleProposal",
    args: [proposalId],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}

export async function settleByAgent(proposalId: bigint, calls: BatchCall[]): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();

  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "settleByAgent",
    args: [proposalId, calls],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}

export async function emergencySettle(proposalId: bigint, calls: BatchCall[]): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();

  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "emergencySettle",
    args: [proposalId, calls],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}

export async function cancelProposal(proposalId: bigint): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();

  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "cancelProposal",
    args: [proposalId],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}

export async function emergencyCancel(proposalId: bigint): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();

  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "emergencyCancel",
    args: [proposalId],
  });

  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}

// ── Parameter setters (owner-only) ──

export async function setVotingPeriod(seconds: bigint): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();
  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "setVotingPeriod",
    args: [seconds],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}

export async function setExecutionWindow(seconds: bigint): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();
  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "setExecutionWindow",
    args: [seconds],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}

export async function setQuorumBps(bps: bigint): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();
  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "setQuorumBps",
    args: [bps],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}

export async function setMaxPerformanceFeeBps(bps: bigint): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();
  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "setMaxPerformanceFeeBps",
    args: [bps],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}

export async function setMaxStrategyDuration(seconds: bigint): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();
  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "setMaxStrategyDuration",
    args: [seconds],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}

export async function setCooldownPeriod(seconds: bigint): Promise<Hex> {
  const wallet = getWalletClient();
  const client = getPublicClient();
  const hash = await wallet.writeContract({
    account: getAccount(),
    chain: getChain(),
    address: getGovernorAddress(),
    abi: SYNDICATE_GOVERNOR_ABI,
    functionName: "setCooldownPeriod",
    args: [seconds],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt.transactionHash;
}
