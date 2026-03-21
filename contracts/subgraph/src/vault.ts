import { BigDecimal, BigInt, dataSource } from "@graphprotocol/graph-ts";
import {
  AgentRegistered,
  AgentRemoved,
  Deposit as DepositEvent,
  Withdraw as WithdrawEvent,
  DepositorApproved,
  DepositorRemoved,
  OpenDepositsUpdated,
} from "../generated/templates/SyndicateVault/SyndicateVault";
import {
  Syndicate,
  Agent,
  Deposit,
  Withdrawal,
  Depositor,
} from "../generated/schema";

// USDC has 6 decimals
let USDC_DECIMALS = 6;

function toDecimal(value: BigInt, decimals: i32): BigDecimal {
  let factor = BigInt.fromI32(10).pow(decimals as u8).toBigDecimal();
  return value.toBigDecimal().div(factor);
}

function getSyndicateId(): string {
  let context = dataSource.context();
  return context.getString("syndicateId");
}

// ── Agent Management ──

export function handleAgentRegistered(event: AgentRegistered): void {
  let syndicateId = getSyndicateId();

  let id = event.address.toHexString() + "-" + event.params.agentAddress.toHexString();
  let agent = new Agent(id);

  agent.syndicate = syndicateId;
  agent.agentId = event.params.agentId;
  agent.agentAddress = event.params.agentAddress;
  agent.active = true;
  agent.registeredAt = event.block.timestamp;
  agent.totalBatches = BigInt.zero();
  agent.totalAssetAmount = BigInt.zero();

  agent.save();
}

export function handleAgentRemoved(event: AgentRemoved): void {
  let id = event.address.toHexString() + "-" + event.params.agentAddress.toHexString();
  let agent = Agent.load(id);
  if (agent == null) return;

  agent.active = false;
  agent.save();
}

// ── LP Events (ERC-4626) ──

export function handleDeposit(event: DepositEvent): void {
  let syndicateId = getSyndicateId();

  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let deposit = new Deposit(id);

  deposit.syndicate = syndicateId;
  deposit.sender = event.params.sender;
  deposit.owner = event.params.owner;
  deposit.assets = event.params.assets;
  deposit.shares = event.params.shares;
  deposit.timestamp = event.block.timestamp;
  deposit.blockNumber = event.block.number;
  deposit.txHash = event.transaction.hash;

  deposit.save();

  // Update syndicate totals
  let syndicate = Syndicate.load(syndicateId);
  if (syndicate != null) {
    syndicate.totalDeposits = syndicate.totalDeposits.plus(
      toDecimal(event.params.assets, USDC_DECIMALS)
    );
    syndicate.save();
  }
}

export function handleWithdraw(event: WithdrawEvent): void {
  let syndicateId = getSyndicateId();

  let id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  let withdrawal = new Withdrawal(id);

  withdrawal.syndicate = syndicateId;
  withdrawal.sender = event.params.sender;
  withdrawal.receiver = event.params.receiver;
  withdrawal.owner = event.params.owner;
  withdrawal.assets = event.params.assets;
  withdrawal.shares = event.params.shares;
  withdrawal.timestamp = event.block.timestamp;
  withdrawal.blockNumber = event.block.number;
  withdrawal.txHash = event.transaction.hash;

  withdrawal.save();

  // Update syndicate totals
  let syndicate = Syndicate.load(syndicateId);
  if (syndicate != null) {
    syndicate.totalWithdrawals = syndicate.totalWithdrawals.plus(
      toDecimal(event.params.assets, USDC_DECIMALS)
    );
    syndicate.save();
  }
}

// ── Depositor Whitelist ──

export function handleDepositorApproved(event: DepositorApproved): void {
  let syndicateId = getSyndicateId();

  let id = event.address.toHexString() + "-" + event.params.depositor.toHexString();
  let depositor = new Depositor(id);

  depositor.syndicate = syndicateId;
  depositor.address = event.params.depositor;
  depositor.approved = true;
  depositor.approvedAt = event.block.timestamp;

  depositor.save();
}

export function handleDepositorRemoved(event: DepositorRemoved): void {
  let id = event.address.toHexString() + "-" + event.params.depositor.toHexString();
  let depositor = Depositor.load(id);
  if (depositor == null) return;

  depositor.approved = false;
  depositor.save();
}

// ── Config Changes ──

export function handleOpenDepositsUpdated(event: OpenDepositsUpdated): void {
  // Open deposits toggle — indexed for event filtering.
}


