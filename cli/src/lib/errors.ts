/**
 * Contract error decoding — turns raw reverts into human-readable messages.
 *
 * Uses viem's decodeErrorResult() against a combined ABI of all custom errors
 * from SyndicateVault, SyndicateGovernor, GovernorParameters, SyndicateFactory,
 * and strategy contracts.
 */

import { type Hex, decodeErrorResult, BaseError } from "viem";

// ── Combined error-only ABI for decoding ──

export const CONTRACT_ERRORS_ABI = [
  // ── SyndicateVault ──
  { type: "error", name: "InvalidOwner", inputs: [] },
  { type: "error", name: "InvalidExecutorImpl", inputs: [] },
  { type: "error", name: "NotActiveAgent", inputs: [] },
  { type: "error", name: "SimulationFailed", inputs: [] },
  { type: "error", name: "InvalidDepositor", inputs: [] },
  { type: "error", name: "DepositorAlreadyApproved", inputs: [] },
  { type: "error", name: "DepositorNotApproved", inputs: [] },
  { type: "error", name: "NotApprovedDepositor", inputs: [] },
  { type: "error", name: "AgentAlreadyRegistered", inputs: [] },
  { type: "error", name: "AgentNotActive", inputs: [] },
  { type: "error", name: "InvalidAgentRegistry", inputs: [] },
  { type: "error", name: "NotAgentOwner", inputs: [] },
  { type: "error", name: "NotGovernor", inputs: [] },
  { type: "error", name: "RedemptionsLocked", inputs: [] },
  { type: "error", name: "DepositsLocked", inputs: [] },
  { type: "error", name: "InvalidAgentAddress", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "CannotRescueAsset", inputs: [] },
  { type: "error", name: "NotFactory", inputs: [] },

  // ── SyndicateGovernor ──
  { type: "error", name: "VaultNotRegistered", inputs: [] },
  { type: "error", name: "VaultAlreadyRegistered", inputs: [] },
  { type: "error", name: "NotRegisteredAgent", inputs: [] },
  { type: "error", name: "PerformanceFeeTooHigh", inputs: [] },
  { type: "error", name: "StrategyDurationTooLong", inputs: [] },
  { type: "error", name: "StrategyDurationTooShort", inputs: [] },
  { type: "error", name: "EmptyExecuteCalls", inputs: [] },
  { type: "error", name: "EmptySettlementCalls", inputs: [] },
  { type: "error", name: "NotWithinVotingPeriod", inputs: [] },
  { type: "error", name: "NoVotingPower", inputs: [] },
  { type: "error", name: "AlreadyVoted", inputs: [] },
  { type: "error", name: "ProposalNotFound", inputs: [] },
  { type: "error", name: "ProposalNotApproved", inputs: [] },
  { type: "error", name: "ExecutionWindowExpired", inputs: [] },
  { type: "error", name: "StrategyAlreadyActive", inputs: [] },
  { type: "error", name: "CooldownNotElapsed", inputs: [] },
  { type: "error", name: "ProposalNotExecuted", inputs: [] },
  { type: "error", name: "ProposalNotCancellable", inputs: [] },
  { type: "error", name: "NotProposer", inputs: [] },
  { type: "error", name: "InvalidVotingPeriod", inputs: [] },
  { type: "error", name: "InvalidExecutionWindow", inputs: [] },
  { type: "error", name: "InvalidVetoThresholdBps", inputs: [] },
  { type: "error", name: "InvalidMaxPerformanceFeeBps", inputs: [] },
  { type: "error", name: "InvalidStrategyDurationBounds", inputs: [] },
  { type: "error", name: "InvalidCooldownPeriod", inputs: [] },
  { type: "error", name: "InvalidVault", inputs: [] },
  { type: "error", name: "NotVaultOwner", inputs: [] },
  { type: "error", name: "StrategyDurationNotElapsed", inputs: [] },
  { type: "error", name: "InvalidProtocolFeeBps", inputs: [] },
  { type: "error", name: "InvalidProtocolFeeRecipient", inputs: [] },
  { type: "error", name: "NotCoProposer", inputs: [] },
  { type: "error", name: "CollaborationExpired", inputs: [] },
  { type: "error", name: "AlreadyApproved", inputs: [] },
  { type: "error", name: "InvalidSplits", inputs: [] },
  { type: "error", name: "TooManyCoProposers", inputs: [] },
  { type: "error", name: "SplitTooLow", inputs: [] },
  { type: "error", name: "LeadSplitTooLow", inputs: [] },
  { type: "error", name: "DuplicateCoProposer", inputs: [] },
  { type: "error", name: "NotDraftState", inputs: [] },
  { type: "error", name: "InvalidCollaborationWindow", inputs: [] },
  { type: "error", name: "NotAuthorized", inputs: [] },
  { type: "error", name: "InvalidMaxCoProposers", inputs: [] },
  { type: "error", name: "Reentrancy", inputs: [] },

  // ── GovernorParameters (timelock) ──
  { type: "error", name: "ChangeAlreadyPending", inputs: [] },
  { type: "error", name: "NoChangePending", inputs: [] },
  { type: "error", name: "ChangeNotReady", inputs: [] },
  { type: "error", name: "InvalidParameterChangeDelay", inputs: [] },
  { type: "error", name: "InvalidParameterKey", inputs: [] },

  // ── SyndicateFactory ──
  { type: "error", name: "InvalidVaultImpl", inputs: [] },
  { type: "error", name: "InvalidENSRegistrar", inputs: [] },
  { type: "error", name: "SubdomainTooShort", inputs: [] },
  { type: "error", name: "SubdomainTaken", inputs: [] },
  { type: "error", name: "NotCreator", inputs: [] },
  { type: "error", name: "InvalidGovernor", inputs: [] },
  { type: "error", name: "InsufficientCreationFee", inputs: [] },
  { type: "error", name: "InvalidFeeToken", inputs: [] },
  { type: "error", name: "ManagementFeeTooHigh", inputs: [] },
  { type: "error", name: "UpgradesDisabled", inputs: [] },
  { type: "error", name: "VaultNotDeployed", inputs: [] },
  { type: "error", name: "StrategyActive", inputs: [] },

  // ── BaseStrategy ──
  { type: "error", name: "AlreadyInitialized", inputs: [] },
  { type: "error", name: "NotVault", inputs: [] },
  { type: "error", name: "NotExecuted", inputs: [] },
  { type: "error", name: "AlreadyExecuted", inputs: [] },
  { type: "error", name: "AlreadySettled", inputs: [] },

  // ── MoonwellSupplyStrategy / WstETHMoonwellStrategy ──
  { type: "error", name: "InvalidAmount", inputs: [] },
  { type: "error", name: "MintFailed", inputs: [] },
  { type: "error", name: "RedeemFailed", inputs: [] },

  // ── AerodromeLPStrategy ──
  { type: "error", name: "GaugeMismatch", inputs: [] },

  // ── WstETHMoonwellStrategy / VeniceInferenceStrategy ──
  { type: "error", name: "SwapFailed", inputs: [] },
  { type: "error", name: "AlreadySettledParams", inputs: [] },

  // ── VeniceInferenceStrategy ──
  { type: "error", name: "NoAgent", inputs: [] },
] as const;

// ── Human-readable error messages ──

const ERROR_MESSAGES: Record<string, string> = {
  // Vault — permissions / state
  InvalidOwner: "The caller is not the vault owner.",
  NotActiveAgent: "Your wallet is not registered as an active agent on this vault. Ask the creator to run: sherwood syndicate approve --agent-id <id> --wallet <your-address>",
  NotApprovedDepositor: "Your address is not on the depositor whitelist. Ask the vault creator to approve you.",
  NotGovernor: "This operation can only be called by the governor contract.",
  NotFactory: "This operation can only be called by the factory contract.",
  RedemptionsLocked: "Redemptions are locked while a strategy is executing. Wait for the proposal to be settled.",
  DepositsLocked: "Deposits are locked while an active proposal exists. Wait for settlement.",
  InvalidDepositor: "Invalid depositor address.",
  DepositorAlreadyApproved: "This depositor is already on the whitelist.",
  DepositorNotApproved: "This depositor is not on the whitelist.",
  AgentAlreadyRegistered: "This agent wallet is already registered on the vault.",
  AgentNotActive: "This agent is registered but not active.",
  InvalidAgentRegistry: "Agent registry address is invalid.",
  NotAgentOwner: "You do not own this ERC-8004 agent identity NFT.",
  InvalidAgentAddress: "Invalid agent wallet address (cannot be zero).",
  InvalidExecutorImpl: "Executor implementation address is invalid.",
  SimulationFailed: "Transaction simulation failed — the batch calls would revert onchain.",
  TransferFailed: "ERC-20 token transfer failed. Check token balance and approvals.",
  ZeroAddress: "A required address parameter is the zero address.",
  CannotRescueAsset: "Cannot rescue the vault's underlying asset — use redeem() instead.",

  // Governor — proposal lifecycle
  VaultNotRegistered: "This vault is not registered with the governor. The factory registers vaults automatically on creation.",
  VaultAlreadyRegistered: "This vault is already registered with the governor.",
  NotRegisteredAgent: "Your wallet is not a registered agent on this vault. Register first via: sherwood syndicate approve",
  PerformanceFeeTooHigh: "Performance fee exceeds the governor's maxPerformanceFeeBps. Check: sherwood governor info",
  StrategyDurationTooLong: "Strategy duration exceeds the governor's maxStrategyDuration. Check: sherwood governor info",
  StrategyDurationTooShort: "Strategy duration is below the governor's minStrategyDuration. Check: sherwood governor info",
  EmptyExecuteCalls: "Proposal must include at least one execute call.",
  EmptySettlementCalls: "Proposal must include at least one settlement call.",
  NotWithinVotingPeriod: "Voting period has not started or has already ended. Check: sherwood proposal show <id>",
  NoVotingPower: "You have no voting power (zero vault shares at the snapshot time).",
  AlreadyVoted: "You have already voted on this proposal.",
  ProposalNotFound: "Proposal does not exist. Check the proposal ID.",
  ProposalNotApproved: "Proposal is not in Approved state. It may still be in voting or was rejected.",
  ExecutionWindowExpired: "The execution window has closed. The proposal is now Expired.",
  StrategyAlreadyActive: "Another strategy is currently executing on this vault. Settle it first before executing a new proposal.",
  CooldownNotElapsed: "A proposal was recently settled. Wait for the cooldown period to elapse. Check: sherwood governor info",
  ProposalNotExecuted: "Proposal has not been executed yet. Execute it first.",
  ProposalNotCancellable: "This proposal cannot be cancelled in its current state.",
  NotProposer: "Only the original proposer can perform this action.",
  StrategyDurationNotElapsed: "Strategy duration has not elapsed yet. Only the proposer can settle early.",

  // Governor — parameter validation
  InvalidVotingPeriod: "Voting period is outside allowed bounds (check governor constants).",
  InvalidExecutionWindow: "Execution window is outside allowed bounds.",
  InvalidVetoThresholdBps: "Veto threshold must be between the allowed bounds (in bps).",
  InvalidMaxPerformanceFeeBps: "Max performance fee is outside allowed bounds.",
  InvalidStrategyDurationBounds: "Strategy duration bounds are invalid (min must be < max).",
  InvalidCooldownPeriod: "Cooldown period is outside allowed bounds.",
  InvalidVault: "Invalid vault address.",
  NotVaultOwner: "Only the vault owner can perform this action.",
  InvalidProtocolFeeBps: "Protocol fee exceeds the 10% maximum (1000 bps).",
  InvalidProtocolFeeRecipient: "Protocol fee recipient must be set before enabling protocol fees.",

  // Governor — collaborative proposals
  NotCoProposer: "You are not listed as a co-proposer on this proposal.",
  CollaborationExpired: "The collaboration window has expired.",
  AlreadyApproved: "This co-proposer has already approved.",
  InvalidSplits: "Co-proposer fee splits must sum correctly with the lead proposer split.",
  TooManyCoProposers: "Exceeds the maximum number of co-proposers. Check: sherwood governor info",
  SplitTooLow: "A co-proposer's fee split is below the minimum.",
  LeadSplitTooLow: "The lead proposer's fee split is below the minimum.",
  DuplicateCoProposer: "Duplicate co-proposer address in the list.",
  NotDraftState: "Proposal must be in Draft state for this operation.",
  InvalidCollaborationWindow: "Collaboration window is outside allowed bounds.",
  NotAuthorized: "You are not authorized to perform this action.",
  InvalidMaxCoProposers: "Max co-proposers value is outside allowed bounds.",
  Reentrancy: "Reentrancy detected — this call cannot be made during another call.",

  // Governor — parameter timelock
  ChangeAlreadyPending: "A parameter change is already pending for this parameter. Finalize or cancel it first.",
  NoChangePending: "No parameter change is pending for this key.",
  ChangeNotReady: "Parameter change timelock has not elapsed yet. Wait for the delay to pass, then finalize.",
  InvalidParameterChangeDelay: "Parameter change delay is outside allowed bounds.",
  InvalidParameterKey: "Unknown parameter key.",

  // Factory
  InvalidVaultImpl: "Vault implementation address is invalid.",
  InvalidENSRegistrar: "ENS registrar address is invalid.",
  SubdomainTooShort: "Subdomain must be at least 3 characters.",
  SubdomainTaken: "This subdomain is already taken. Choose a different name.",
  NotCreator: "Only the syndicate creator can perform this action.",
  InvalidGovernor: "Governor address is invalid.",
  InsufficientCreationFee: "Insufficient creation fee. Check the required fee amount.",
  InvalidFeeToken: "Invalid fee token address.",
  ManagementFeeTooHigh: "Management fee exceeds the maximum allowed.",
  UpgradesDisabled: "Vault upgrades are currently disabled by the factory owner.",
  VaultNotDeployed: "Vault has not been deployed yet.",
  StrategyActive: "Cannot perform this action while a strategy is actively executing.",

  // Strategy — base
  AlreadyInitialized: "This strategy clone was already initialized. Deploy a fresh clone.",
  NotVault: "Only the vault can call this strategy function.",
  NotExecuted: "Strategy has not been executed yet.",
  AlreadyExecuted: "Strategy has already been executed.",
  AlreadySettled: "Strategy has already been settled.",

  // Strategy — Moonwell / WstETH
  InvalidAmount: "Invalid amount — must be greater than zero.",
  MintFailed: "Moonwell cToken mint failed. The underlying supply may have hit the market cap.",
  RedeemFailed: "Moonwell cToken redeem failed. Check that sufficient liquidity is available.",

  // Strategy — Aerodrome
  GaugeMismatch: "Aerodrome gauge does not match the expected pool.",

  // Strategy — WstETH / Venice
  SwapFailed: "Token swap failed. Check slippage tolerance and pool liquidity.",
  AlreadySettledParams: "Settlement parameters have already been set.",

  // Strategy — Venice
  NoAgent: "No agent is registered on the vault. Register an agent first.",
};

// ── Decoding ──

/**
 * Attempt to decode a hex revert selector into a human-readable error message.
 * Returns null if the selector doesn't match any known contract error.
 */
export function decodeContractError(data: Hex): { name: string; message: string } | null {
  try {
    const decoded = decodeErrorResult({
      abi: CONTRACT_ERRORS_ABI,
      data,
    });
    const message = ERROR_MESSAGES[decoded.errorName] || `Contract error: ${decoded.errorName}`;
    return { name: decoded.errorName, message };
  } catch {
    return null;
  }
}

/**
 * Extract a hex error selector from a viem error's walk chain.
 * viem wraps contract call reverts in ContractFunctionRevertedError which
 * contains a `data` field with the raw 4-byte (or longer) revert payload.
 */
function extractRevertData(err: unknown): Hex | null {
  if (!(err instanceof BaseError)) return null;

  // Walk the viem error chain to find revert data
  const revertError = err.walk((e) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (e as any).data !== undefined;
  });

  if (revertError) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (revertError as any).data;
    // data can be the hex string directly, or an object with a data field
    if (typeof data === "string" && data.startsWith("0x")) {
      return data as Hex;
    }
    if (typeof data === "object" && data?.data && typeof data.data === "string") {
      return data.data as Hex;
    }
  }

  // Fallback: extract 0x + hex from the error message (e.g. "reverted with 0x62df0545")
  const msg = err.message || "";
  const match = msg.match(/(?:signature|data)\s*"?(0x[0-9a-fA-F]+)"?/);
  if (match) return match[1] as Hex;

  return null;
}

// ── Known common EVM / ERC-20 revert strings ──

const KNOWN_REVERT_STRINGS: Record<string, string> = {
  "ERC20: transfer amount exceeds balance": "Insufficient token balance for this transfer.",
  "ERC20: transfer amount exceeds allowance": "Token allowance insufficient. An approval step may have been skipped.",
  "ERC20: insufficient allowance": "Token allowance insufficient. An approval step may have been skipped.",
  "Ownable: caller is not the owner": "Only the contract owner can call this function.",
  "Pausable: paused": "The contract is currently paused.",
};

/**
 * Format any caught error into a user-friendly message.
 *
 * Tries (in order):
 * 1. Decode custom error selector from our contract ABIs
 * 2. Match known EVM/ERC-20 revert reason strings
 * 3. Identify nonce / gas issues with actionable advice
 * 4. Fall back to the raw error message
 */
export function formatContractError(err: unknown): string {
  // 1. Try to decode custom contract error
  const revertData = extractRevertData(err);
  if (revertData && revertData.length >= 10) {
    const decoded = decodeContractError(revertData);
    if (decoded) return decoded.message;
  }

  const rawMsg = err instanceof Error ? err.message : String(err);

  // 2. Check for known revert reason strings
  for (const [pattern, message] of Object.entries(KNOWN_REVERT_STRINGS)) {
    if (rawMsg.includes(pattern)) return message;
  }

  // 3. Nonce / gas issues — already handled by retry, but surface clearly if they bubble up
  if (rawMsg.includes("replacement transaction underpriced")) {
    return "A previous transaction is stuck. The CLI retried with higher gas but the error persists. Try again in a moment.";
  }
  if (rawMsg.includes("nonce too low") || rawMsg.includes("NONCE_EXPIRED")) {
    return "Transaction nonce conflict — a previous transaction is still pending. Wait a moment and retry.";
  }
  if (rawMsg.includes("insufficient funds for gas")) {
    return "Insufficient ETH for gas fees. Top up your wallet with ETH on Base.";
  }

  // 4. Clean up common viem wrapper noise
  // Strip "ContractFunctionRevertedError:" prefix and "Docs:" links
  let cleaned = rawMsg
    .replace(/ContractFunctionRevertedError:\s*/g, "")
    .replace(/Docs:\s*https:\/\/\S+/g, "")
    .replace(/Version:\s*viem@\S+/g, "")
    .replace(/Request Arguments:[\s\S]*$/m, "")
    .replace(/Contract Call:[\s\S]*?(?=\n\n|\n[A-Z]|$)/m, "")
    .trim();

  // If we still have "reverted with the following signature: 0x..." try one more decode
  const sigMatch = cleaned.match(/signature[:\s]+"?(0x[0-9a-fA-F]{8,})"?/);
  if (sigMatch) {
    const decoded = decodeContractError(sigMatch[1] as Hex);
    if (decoded) return decoded.message;
    // If we can't decode it, at least explain what it is
    cleaned = `Contract reverted with unknown error selector ${sigMatch[1]}. Check the transaction on Basescan for details.`;
  }

  return cleaned;
}
