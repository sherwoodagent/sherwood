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
    error NotMinterOrOwner();
    error PreparedStakeNotFound();
    error PreparedStakeAlreadyExists();
    error PreparedStakeAlreadyBound();
    error VaultHasActiveProposal();
    error OwnerBondInsufficient();
    error InvalidEpoch();
    error EpochNotEnded();
    error NothingToClaim();
    error FundEpochLocked();
    error SweepTooEarly();
    error ProtocolPaused();
    error NotPausedOrDeadmanNotElapsed();
    error RefundCapExceeded();
    error InvalidAgentId();

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
    event ReviewResolved(uint256 indexed proposalId, bool blocked, uint256 slashedAmount);
    event EmergencyReviewOpened(uint256 indexed proposalId, bytes32 callsHash, uint64 reviewEnd);
    event EmergencyBlockVoteCast(uint256 indexed proposalId, address indexed guardian, uint128 weight);
    event EmergencyReviewResolved(uint256 indexed proposalId, bool blocked, uint256 slashedAmount);
    event EpochFunded(uint256 indexed epochId, address indexed funder, uint256 amount);
    event EpochRewardClaimed(uint256 indexed epochId, address indexed guardian, uint256 amount);
    event EpochUnclaimedSwept(uint256 indexed fromEpoch, uint256 indexed toEpoch, uint256 amount);
    event PendingBurnRecorded(uint256 amount);
    event BurnFlushed(uint256 amount);
    event Paused(address indexed by);
    event Unpaused(address indexed by, bool deadman);
    event SlashAppealReserveFunded(address indexed by, uint256 amount);
    event SlashAppealRefunded(address indexed recipient, uint256 amount, uint256 epochId);

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

    // ── Permissionless ──
    function openReview(uint256 proposalId) external;
    function resolveReview(uint256 proposalId) external returns (bool blocked);
    function resolveEmergencyReview(uint256 proposalId) external returns (bool blocked);
    function voteBlockEmergencySettle(uint256 proposalId) external;
    function flushBurn() external;
    function sweepUnclaimed(uint256 epochId) external;

    // ── Epoch rewards ──
    function fundEpoch(uint256 epochId, uint256 amount) external;
    function claimEpochReward(uint256 epochId) external;

    // ── Slash appeal ──
    function fundSlashAppealReserve(uint256 amount) external;
    function refundSlash(address recipient, uint256 amount) external;

    // ── Pause ──
    function pause() external;
    function unpause() external;

    // ── Parameter setters (timelocked) ──
    function setMinGuardianStake(uint256) external;
    function setMinOwnerStake(uint256) external;
    function setOwnerStakeTvlBps(uint256) external;
    function setCoolDownPeriod(uint256) external;
    function setReviewPeriod(uint256) external;
    function setBlockQuorumBps(uint256) external;
    function setMinter(address) external;

    // ── Views ──
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
    function pendingEpochReward(address guardian, uint256 epochId) external view returns (uint256);
    function governor() external view returns (address);
    function factory() external view returns (address);
}
