// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BatchExecutorLib} from "../BatchExecutorLib.sol";

interface ISyndicateGovernor {
    // ── Enums ──

    enum ProposalState {
        Draft, // collaborative proposal awaiting co-proposer consent
        Pending, // voting active
        GuardianReview, // voting passed, guardian review window active (Task 25)
        Approved, // review ended without block quorum
        Rejected, // voting ended, veto threshold reached OR guardians blocked
        Expired, // execution window passed without execution
        Executed, // strategy is live
        Settled, // P&L calculated, fee distributed
        Cancelled // proposer or owner cancelled
    }

    enum VoteType {
        For,
        Against,
        Abstain
    }

    // ── Structs ──

    struct InitParams {
        address owner;
        uint256 votingPeriod;
        uint256 executionWindow;
        uint256 vetoThresholdBps;
        uint256 maxPerformanceFeeBps;
        uint256 cooldownPeriod;
        uint256 collaborationWindow;
        uint256 maxCoProposers;
        uint256 minStrategyDuration;
        uint256 maxStrategyDuration;
        uint256 protocolFeeBps;
        address protocolFeeRecipient;
        uint256 guardianFeeBps;
    }

    struct GovernorParams {
        uint256 votingPeriod;
        uint256 executionWindow;
        uint256 vetoThresholdBps;
        uint256 maxPerformanceFeeBps;
        uint256 cooldownPeriod;
        uint256 collaborationWindow;
        uint256 maxCoProposers;
        uint256 minStrategyDuration;
        uint256 maxStrategyDuration;
    }

    struct StrategyProposal {
        uint256 id;
        address proposer;
        address vault;
        string metadataURI;
        uint256 performanceFeeBps;
        uint256 strategyDuration;
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 votesAbstain;
        uint256 snapshotTimestamp;
        uint256 voteEnd;
        uint256 reviewEnd; // guardian review window end (Task 25); zero for collaborative drafts
        uint256 executeBy;
        uint256 executedAt;
        ProposalState state;
        /// @dev G-H6: vetoThresholdBps snapshot taken at Draft -> Pending.
        ///      Prevents mid-vote timelock finalizes from retroactively
        ///      moving the rejection threshold.
        uint256 vetoThresholdBps;
    }

    struct CoProposer {
        address agent;
        uint256 splitBps;
    }

    // V1.5: timelock removed. Owner-multisig governs via its own delay.

    // ── Errors ──

    error VaultNotRegistered();
    error VaultAlreadyRegistered();
    error NotRegisteredAgent();
    error PerformanceFeeTooHigh();
    error StrategyDurationTooLong();
    error StrategyDurationTooShort();
    error EmptyExecuteCalls();
    error EmptySettlementCalls();
    error NotWithinVotingPeriod();
    error NoVotingPower();
    error AlreadyVoted();
    error ProposalNotFound();
    error ProposalNotApproved();
    error ExecutionWindowExpired();
    error StrategyAlreadyActive();
    error CooldownNotElapsed();
    error ProposalNotExecuted();
    error ProposalNotCancellable();
    error NotProposer();
    error InvalidVotingPeriod();
    error InvalidExecutionWindow();
    error InvalidVetoThresholdBps();
    error InvalidMaxPerformanceFeeBps();
    error InvalidStrategyDurationBounds();
    error InvalidCooldownPeriod();
    error InvalidVault();
    error ZeroAddress();
    error NotVaultOwner();
    error StrategyDurationNotElapsed();
    error InvalidProtocolFeeBps();
    error InvalidProtocolFeeRecipient();
    /// @notice G-M1: Revert if a vault already has a non-terminal proposal
    ///         (Draft / Pending / GuardianReview / Approved / Executed) when
    ///         a new propose() or approveCollaboration Draft->Pending is
    ///         attempted. Prevents duplicate lifecycles that would race the
    ///         same vault state.
    error VaultHasOpenProposal();
    /// @notice G-M11: Revert if `metadataURI.length` exceeds
    ///         MAX_METADATA_URI_LENGTH. Bounds a calldata-unbounded string
    ///         that would otherwise let a proposer grief gas / event storage.
    error MetadataURITooLong();
    /// @notice G-M2/G-M6: Revert if `executeCalls.length` or
    ///         `settlementCalls.length` exceeds MAX_CALLS_PER_PROPOSAL. Bounds
    ///         calldata-unbounded arrays that otherwise let a proposer grief
    ///         gas when the batch is executed.
    error TooManyCalls();
    /// @notice G-M9: Revert if `addVault(address)` is passed an address that
    ///         does not implement the ISyndicateVault interface (e.g. an EOA
    ///         or an unrelated contract). Catches operator typos that would
    ///         otherwise wire governance at a dead address.
    error NotASyndicateVault();

    // ── Guardian-review emergency settle errors (Task 24) ──
    error OwnerBondInsufficient();
    error EmergencySettleBlocked();
    error EmergencySettleMismatch();

    // ── Guardian-review lifecycle errors (Task 25) ──
    error NotInGuardianReview();
    error EmergencySettleNotReady();
    error RegistryNotSet();

    // ── Collaborative proposal errors ──
    error NotCoProposer();
    error CollaborationExpired();
    error AlreadyApproved();
    error InvalidSplits();
    error TooManyCoProposers();
    error SplitTooLow();
    error LeadSplitTooLow();
    error DuplicateCoProposer();
    error NotDraftState();
    error InvalidCollaborationWindow();
    error NotAuthorized();
    error InvalidMaxCoProposers();
    error Reentrancy();
    /// @notice Revert if lead tries to cancel a Draft once all-but-one
    ///         co-proposer has approved (G-H2). Prevents front-running the
    ///         final approve tx.
    error CancelNotAllowedNearQuorum();
    /// @notice Revert when `getVoteWeight` is called on a Draft proposal whose
    ///         snapshotTimestamp hasn't been stamped yet (G-H3). The prior
    ///         silent zero return confused callers who assumed no power.
    error ProposalInDraft();
    /// @notice Revert if an active co-proposer's rounded share is 0 (G-C7).
    /// @dev Prevents silent routing of zero-rounded shares to the lead.
    error CoProposerShareUnderflow();

    // V1.5 new parameter errors
    error InvalidGuardianFeeBps();

    // ── Events ──

    event ProposalCreated(
        uint256 indexed proposalId,
        address indexed proposer,
        address indexed vault,
        uint256 performanceFeeBps,
        uint256 strategyDuration,
        uint256 executeCallCount,
        uint256 settlementCallCount,
        string metadataURI
    );

    event VoteCast(uint256 indexed proposalId, address indexed voter, VoteType support, uint256 weight);

    event ProposalExecuted(uint256 indexed proposalId, address indexed vault, uint256 capitalSnapshot);

    event ProposalSettled(
        uint256 indexed proposalId, address indexed vault, int256 pnl, uint256 performanceFee, uint256 duration
    );

    event ProposalCancelled(uint256 indexed proposalId, address indexed cancelledBy);

    event ProposalVetoed(uint256 indexed proposalId, address indexed vetoedBy);

    event EmergencySettled(uint256 indexed proposalId, address indexed vault, int256 pnl, uint256 customCallCount);

    // ── Fee-distribution resilience events (W-1) ──
    /// @notice Emitted when a per-recipient fee transfer in `_distributeFees` /
    ///         `_distributeAgentFee` reverts (e.g., USDC blacklist). The amount
    ///         is escrowed against `(vault, recipient, token)` in storage (see
    ///         `unclaimedFees`). `reason` dropped from the event to conserve
    ///         governor bytecode — the revert data is visible in the tx trace
    ///         if a debugger needs the underlying cause.
    event FeeTransferFailed(address indexed recipient, address indexed token, uint256 amount);
    /// @notice Emitted when a recipient pulls previously escrowed fees via
    ///         `claimUnclaimedFees`. The originating vault is the caller's
    ///         argument to `claimUnclaimedFees` (traceable via `tx.input`).
    event FeeClaimed(address indexed recipient, address indexed token, uint256 amount);

    // ── Guardian-review emergency settle events (Task 24) ──
    event EmergencySettleProposed(
        uint256 indexed proposalId, address indexed owner, bytes32 callsHash, uint64 reviewEnd
    );
    event EmergencySettleCancelled(uint256 indexed proposalId, address indexed owner);
    event EmergencySettleFinalized(uint256 indexed proposalId, int256 pnl);

    // ── Guardian-review lifecycle events (Task 25) ──
    event GuardianReviewResolved(uint256 indexed proposalId, bool blocked);

    event VaultAdded(address indexed vault);
    event VaultRemoved(address indexed vault);
    // All parameter updates (votingPeriod / executionWindow / vetoThresholdBps /
    // maxPerformanceFeeBps / minStrategyDuration / maxStrategyDuration /
    // cooldownPeriod / collaborationWindow / maxCoProposers / protocolFeeBps /
    // protocolFeeRecipient / factory) are surfaced via the uniform
    // `ParameterChangeFinalized(paramKey, oldValue, newValue)` event. Off-chain
    // consumers filter by `keccak256(name)` rather than per-param topics.

    // ── Collaborative proposal events ──
    event CollaborativeProposalCreated(
        uint256 indexed proposalId, address indexed leadProposer, address[] coProposers, uint256[] splitsBps
    );
    event CollaborationApproved(uint256 indexed proposalId, address indexed agent);
    event CollaborationRejected(uint256 indexed proposalId, address indexed agent);
    event CollaborationTransitionedToPending(uint256 indexed proposalId);
    event CollaborationDeadlineExpired(uint256 indexed proposalId);

    // ── Parameter change event (V1.5: owner-instant, no queue/cancel) ──
    event ParameterChangeFinalized(bytes32 indexed paramKey, uint256 oldValue, uint256 newValue);

    /// @notice V1.5: emitted in `_distributeFees` when `guardianFeeBps > 0`.
    ///         Guardian fee is carved from gross PnL and transferred to
    ///         `recipient` (GuardianRegistry in V1.5).
    event GuardianFeeAccrued(
        uint256 indexed proposalId,
        address indexed asset,
        address indexed recipient,
        uint256 amount,
        uint64 settledAt
    );

    /// @notice V1.5: W-1 regression guard. Emitted when the guardian-fee
    ///         transfer from the vault to the recipient reverts (e.g.
    ///         recipient blacklisted on USDC). The fee stays in the vault.
    event GuardianFeeDeliveryFailed(
        uint256 indexed proposalId, address indexed asset, address indexed recipient, uint256 amount
    );

    /// @notice V1.5: W-1 regression guard. Emitted when the transfer succeeds
    ///         but the recipient's `fundProposalGuardianPool` call reverts
    ///         (misconfigured recipient, registry upgrade bug). The asset is
    ///         in the recipient's balance but no pool is stamped — ops can
    ///         recover via the recipient contract's owner.
    event GuardianFeePoolFundingFailed(
        uint256 indexed proposalId, address indexed asset, address indexed recipient, uint256 amount
    );

    // ── Functions ──

    function propose(
        address vault,
        string calldata metadataURI,
        uint256 performanceFeeBps,
        uint256 strategyDuration,
        BatchExecutorLib.Call[] calldata executeCalls,
        BatchExecutorLib.Call[] calldata settlementCalls,
        CoProposer[] calldata coProposers
    ) external returns (uint256 proposalId);

    function vote(uint256 proposalId, VoteType support) external;

    function executeProposal(uint256 proposalId) external;

    function settleProposal(uint256 proposalId) external;

    // ── Guardian-review emergency settle lifecycle (Task 24) ──
    // NOTE (Task 25 / PR #229): legacy `emergencySettle` removed — use
    // `unstick` (pre-committed calls) or `emergencySettleWithCalls` +
    // `finalizeEmergencySettle` (guardian-gated) for the owner-driven path.
    function unstick(uint256 proposalId) external;
    function emergencySettleWithCalls(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external;
    function cancelEmergencySettle(uint256 proposalId) external;
    function finalizeEmergencySettle(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) external;

    function cancelProposal(uint256 proposalId) external;

    function emergencyCancel(uint256 proposalId) external;

    /// @notice Vault owner vetoes a Pending proposal only, setting it to Rejected.
    /// @dev Narrowed in PR #229 (Task 25) so guardians own post-review blocks —
    ///      once a proposal has passed voting and entered `GuardianReview`, the
    ///      guardian cohort and execution window drive the outcome rather than
    ///      unilateral owner action. Use `emergencyCancel` for Draft/Pending.
    function vetoProposal(uint256 proposalId) external;

    // ── Collaborative proposal functions ──

    function approveCollaboration(uint256 proposalId) external;
    function rejectCollaboration(uint256 proposalId) external;

    // ── Setters (owner-instant; owner is a multisig with external delay) ──

    function addVault(address vault) external;
    function removeVault(address vault) external;
    function setFactory(address factory_) external;
    function setVotingPeriod(uint256 newVotingPeriod) external;
    function setExecutionWindow(uint256 newExecutionWindow) external;
    function setVetoThresholdBps(uint256 newVetoThresholdBps) external;
    function setMaxPerformanceFeeBps(uint256 newMaxPerformanceFeeBps) external;
    function setMinStrategyDuration(uint256 newMinStrategyDuration) external;
    function setMaxStrategyDuration(uint256 newMaxStrategyDuration) external;
    function setCooldownPeriod(uint256 newCooldownPeriod) external;
    function setCollaborationWindow(uint256 newCollaborationWindow) external;
    function setMaxCoProposers(uint256 newMaxCoProposers) external;
    function setProtocolFeeBps(uint256 newProtocolFeeBps) external;
    function setProtocolFeeRecipient(address newRecipient) external;
    function setGuardianFeeBps(uint256 newValue) external;
    function guardianFeeBps() external view returns (uint256);

    // ── Views ──

    function getProposal(uint256 proposalId) external view returns (StrategyProposal memory);
    function getProposalState(uint256 proposalId) external view returns (ProposalState);
    function getProposalCalls(uint256 proposalId) external view returns (BatchExecutorLib.Call[] memory);
    function getExecuteCalls(uint256 proposalId) external view returns (BatchExecutorLib.Call[] memory);
    function getSettlementCalls(uint256 proposalId) external view returns (BatchExecutorLib.Call[] memory);
    function getVoteWeight(uint256 proposalId, address voter) external view returns (uint256);
    function hasVoted(uint256 proposalId, address voter) external view returns (bool);
    function proposalCount() external view returns (uint256);
    function getGovernorParams() external view returns (GovernorParams memory);
    function getRegisteredVaults() external view returns (address[] memory);
    function getActiveProposal(address vault) external view returns (uint256);
    /// @notice Count of proposals for a vault in any non-terminal state
    ///         (Pending / GuardianReview / Approved / Executed).
    /// @dev Incremented on Draft -> Pending, decremented on the terminal edge
    ///      (Rejected / Expired / Cancelled / Settled). Consumed by
    ///      `GuardianRegistry.requestUnstakeOwner` alongside `getActiveProposal`
    ///      to block rage-quit while any proposal binds the vault — the OR
    ///      check is belt-and-braces so stale-cache transitions can't slip
    ///      through. See PR #229 Fix 2.
    function openProposalCount(address vault) external view returns (uint256);
    function getCooldownEnd(address vault) external view returns (uint256);
    function getCapitalSnapshot(uint256 proposalId) external view returns (uint256);
    function isRegisteredVault(address vault) external view returns (bool);
    function getCoProposers(uint256 proposalId) external view returns (CoProposer[] memory);
    // V1.5: getPendingChange removed (no queue).
    function protocolFeeBps() external view returns (uint256);
    function protocolFeeRecipient() external view returns (address);

    /// @notice Address of the guardian registry (zero if not yet wired).
    function guardianRegistry() external view returns (address);

    // ── Fee-escrow (W-1) ──

    /// @notice Pull previously escrowed fees after the blacklist / revert
    ///         condition that caused the original settlement transfer has been
    ///         lifted. Escrow is keyed by origin vault — a recipient can only
    ///         claim against the specific vault whose fee transfer failed.
    /// @param vault The vault that originally held the fee asset.
    /// @param token The ERC-20 address the fee was denominated in.
    function claimUnclaimedFees(address vault, address token) external;

    /// @notice Amount of fees escrowed against `(vault, recipient)` in `token`
    ///         awaiting a retryable claim. Zero for `(vault, recipient, token)`
    ///         tuples that never had a failed transfer.
    function unclaimedFees(address vault, address recipient, address token) external view returns (uint256);
}
