// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BatchExecutorLib} from "../BatchExecutorLib.sol";

interface IGuardianRegistry {
    // ── Enums ──
    enum GuardianVoteType {
        None,
        Approve,
        Block
    }

    // ── Errors ──
    error ZeroAddress();
    error InsufficientStake();
    error NoActiveStake();
    error CooldownNotElapsed();
    error UnstakeNotRequested();
    error UnstakeAlreadyRequested();
    error NotActiveGuardian();
    error AlreadyVoted();
    error NoVoteChange();
    error VoteChangeLockedOut();
    error NewSideFull();
    error ReviewNotOpen();
    error ReviewNotReadyForResolve();
    error NotFactory();
    error NotGovernor();
    error PreparedStakeNotFound();
    error PreparedStakeAlreadyExists();
    error PreparedStakeAlreadyBound();
    error VaultHasActiveProposal();
    error OwnerBondInsufficient();
    // V1.5 removed: InvalidEpoch, EpochNotEnded, NothingToClaim, FundEpochLocked,
    // SweepTooEarly — all tied to the on-chain epoch-claim path now in Merkl.
    error ProtocolPaused();
    error NotPausedOrDeadmanNotElapsed();
    error RefundCapExceeded();
    // V1.5 delegation
    error CannotSelfDelegate();
    error InvalidDelegate();
    error InactiveDelegate();
    error AmountZero();
    error NoActiveDelegation();
    error NoUnstakeRequest();
    error UnstakeCooldownActive();
    // V1.5 Phase 3 — commission + claim
    error CommissionExceedsMax();
    error CommissionRaiseExceedsLimit();
    error NoPoolFunded();
    error AlreadyClaimed();
    error NotApprover();
    error NoDelegationAtSettle();
    error DelegatePoolEmpty();
    error NoEscrowedAmount();
    error InvalidParameter();

    // ── Events ──
    event GuardianStaked(address indexed guardian, uint256 amount, uint256 agentId);
    event GuardianUnstakeRequested(address indexed guardian, uint256 requestedAt);
    event GuardianUnstakeCancelled(address indexed guardian);
    event GuardianUnstakeClaimed(address indexed guardian, uint256 amount);
    event OwnerStakePrepared(address indexed owner, uint256 amount);
    event PreparedStakeCancelled(address indexed owner, uint256 amount);
    event OwnerStakeBound(address indexed owner, address indexed vault, uint256 amount);
    event OwnerStakeSlotTransferred(address indexed vault, address indexed oldOwner, address indexed newOwner);
    event OwnerUnstakeRequested(address indexed vault, uint256 requestedAt);
    event OwnerUnstakeClaimed(address indexed vault, address indexed owner, uint256 amount);
    event ReviewOpened(uint256 indexed proposalId, uint128 totalStakeAtOpen);
    event CohortTooSmallToReview(uint256 indexed proposalId, uint256 totalStakeAtOpen);
    event GuardianVoteCast(
        uint256 indexed proposalId, address indexed guardian, GuardianVoteType support, uint128 weight
    );
    event GuardianVoteChanged(
        uint256 indexed proposalId, address indexed guardian, GuardianVoteType from, GuardianVoteType to
    );
    event ApproverCapReached(uint256 indexed proposalId);
    /// @notice ToB I-2: emitted when a Block vote is rejected because the
    ///         blocker array has hit `MAX_BLOCKERS_PER_PROPOSAL`. Parallels
    ///         `ApproverCapReached`.
    event BlockerCapReached(uint256 indexed proposalId);
    event ReviewResolved(uint256 indexed proposalId, bool blocked, uint256 slashedAmount);
    event EmergencyReviewOpened(uint256 indexed proposalId, bytes32 callsHash, uint64 reviewEnd);
    event EmergencyReviewCancelled(uint256 indexed proposalId);
    event EmergencyBlockVoteCast(uint256 indexed proposalId, address indexed guardian, uint128 weight);
    event EmergencyReviewResolved(uint256 indexed proposalId, bool blocked, uint256 slashedAmount);
    // Emitted per blocker when a review resolves blocked = true. Merkl's
    // off-chain bot reads this to build the epoch WOOD campaign's Merkle roots.
    // (WOOD epoch budgets live in Merkl — the funding tx is a plain ERC20
    // transfer, no on-chain event needed in this registry.)
    event BlockerAttributed(
        uint256 indexed proposalId, uint256 indexed epochId, address indexed blocker, uint256 weight
    );
    event PendingBurnRecorded(uint256 amount);
    event BurnFlushed(uint256 amount);
    event Paused(address indexed by);
    event Unpaused(address indexed by, bool deadman);
    event SlashAppealReserveFunded(address indexed by, uint256 amount);
    event SlashAppealRefunded(address indexed recipient, uint256 amount, uint256 epochId);
    event ParameterChangeFinalized(bytes32 indexed paramKey, uint256 oldValue, uint256 newValue);

    // ── Guardian fns ──
    function stakeAsGuardian(uint256 amount, uint256 agentId) external;
    function requestUnstakeGuardian() external;
    function cancelUnstakeGuardian() external;
    function claimUnstakeGuardian() external;
    function voteOnProposal(uint256 proposalId, GuardianVoteType support) external;

    // ── Owner fns ──
    function prepareOwnerStake(uint256 amount) external;
    function cancelPreparedStake() external;
    function requestUnstakeOwner(address vault) external;
    function claimUnstakeOwner(address vault) external;

    // ── Factory-only ──
    function bindOwnerStake(address owner, address vault) external;
    function transferOwnerStakeSlot(address vault, address newOwner) external;

    // ── Governor-only ──
    function openEmergencyReview(uint256 proposalId, bytes32 callsHash) external;
    function cancelEmergencyReview(uint256 proposalId) external;

    // ── Permissionless ──
    function openReview(uint256 proposalId) external;
    function resolveReview(uint256 proposalId) external returns (bool blocked);
    function resolveEmergencyReview(uint256 proposalId) external returns (bool blocked);
    function voteBlockEmergencySettle(uint256 proposalId) external;
    function flushBurn() external;

    // ── Slash appeal ──
    function fundSlashAppealReserve(uint256 amount) external;
    function refundSlash(address recipient, uint256 amount) external;

    // ── Pause ──
    function pause() external;
    function unpause() external;

    // ── Parameter setters (owner-instant; owner is a multisig with external delay) ──
    function setMinGuardianStake(uint256) external;
    function setMinOwnerStake(uint256) external;
    function setCooldownPeriod(uint256) external;
    function setReviewPeriod(uint256) external;
    function setBlockQuorumBps(uint256) external;

    // ── Views ──
    /// @notice Returns the cached review state for a proposal (Task 25).
    /// @return opened Whether `openReview` was called
    /// @return resolved Whether `resolveReview` has finalized the review
    /// @return blocked Whether guardians reached the block quorum (requires resolved)
    /// @return cohortTooSmall Whether the cohort at open was below MIN_COHORT_STAKE_AT_OPEN
    function getReviewState(uint256 proposalId)
        external
        view
        returns (bool opened, bool resolved, bool blocked, bool cohortTooSmall);

    function reviewPeriod() external view returns (uint256);
    function guardianStake(address guardian) external view returns (uint256);
    function ownerStake(address vault) external view returns (uint256);
    function totalGuardianStake() external view returns (uint256);
    function isActiveGuardian(address guardian) external view returns (bool);
    function hasOwnerStake(address vault) external view returns (bool);
    function preparedStakeOf(address owner) external view returns (uint256);
    function canCreateVault(address owner) external view returns (bool);
    function requiredOwnerBond(address vault) external view returns (uint256);
    function currentEpoch() external view returns (uint256);
    // V1.5: pendingEpochReward removed — query Merkl API / merkl.xyz for pending rewards.
    function governor() external view returns (address);
    function factory() external view returns (address);

    // ── V1.5: delegation ──
    function delegateStake(address delegate, uint256 amount) external;
    function requestUnstakeDelegation(address delegate) external;
    function cancelUnstakeDelegation(address delegate) external;
    function claimUnstakeDelegation(address delegate) external;

    function delegationOf(address delegator, address delegate) external view returns (uint256);
    function delegatedInbound(address delegate) external view returns (uint256);
    function totalDelegatedStake() external view returns (uint256);

    function getPastStake(address guardian, uint256 timestamp) external view returns (uint256);
    function getPastTotalStake(uint256 timestamp) external view returns (uint256);
    function getPastDelegated(address delegate, uint256 timestamp) external view returns (uint256);
    function getPastDelegationTo(address delegator, address delegate, uint256 timestamp) external view returns (uint256);
    function getPastVoteWeight(address delegate, uint256 timestamp) external view returns (uint256);
    function getPastTotalDelegated(uint256 timestamp) external view returns (uint256);

    event DelegationIncreased(address indexed delegator, address indexed delegate, uint256 amount);
    event DelegationUnstakeRequested(address indexed delegator, address indexed delegate, uint256 at);
    event DelegationUnstakeCancelled(address indexed delegator, address indexed delegate);
    event DelegationUnstakeClaimed(address indexed delegator, address indexed delegate, uint256 amount);

    // ── V1.5 Phase 3: DPoS commission ──
    function setCommission(uint256 newBps) external;
    function commissionOf(address delegate) external view returns (uint256);
    function commissionAt(address delegate, uint256 timestamp) external view returns (uint256);

    event CommissionSet(address indexed delegate, uint256 oldBps, uint256 newBps);

    // ── V1.5 Phase 3: on-chain guardian-fee pool (vault assets) ──
    /// @notice Called by governor in `_distributeFees` after transferring the
    ///         guardian-fee slice to the registry. Stamps the pool with
    ///         `(asset, amount, settledAt)` so approvers + delegators can
    ///         claim pro-rata. See spec §4.8.
    function fundProposalGuardianPool(uint256 proposalId, address asset, uint256 amount) external;

    /// @notice Approver pulls their pro-rata share; DPoS commission is kept by
    ///         the approver, remainder is stored for delegator claim.
    function claimProposalReward(uint256 proposalId) external;

    /// @notice Delegator pulls their share from delegate's remainder pool.
    ///         Delegate must have claimed first (seeds the pool).
    function claimDelegatorProposalReward(address delegate, uint256 proposalId) external;

    /// @notice Pull previously-escrowed guardian-fee reward after the transfer-
    ///         failure condition has been lifted. Keyed by (proposalId, recipient,
    ///         asset) so cross-proposal drain is impossible.
    function flushUnclaimedApproverFee(uint256 proposalId, address recipient, address asset) external;

    // unclaimedApproverFee view removed — escrow is observable via
    // ApproverFeeEscrowed event + eth_getStorageAt at keccak256(pid, recipient, asset).

    event ProposalGuardianPoolFunded(uint256 indexed proposalId, address indexed asset, uint256 amount);
    event ApproverRewardClaimed(
        uint256 indexed proposalId, address indexed approver, uint256 gross, uint256 commission, uint256 remainder
    );
    event DelegatorProposalRewardClaimed(
        address indexed delegator, address indexed delegate, uint256 indexed proposalId, uint256 share
    );
    event ApproverFeeEscrowed(
        uint256 indexed proposalId, address indexed recipient, address indexed asset, uint256 amount
    );
    // Flush is observable via ERC20 Transfer + unclaimedApproverFee = 0 — no
    // dedicated event (saves bytecode).
}
