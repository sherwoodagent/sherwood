// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IGuardianRegistry} from "./interfaces/IGuardianRegistry.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title GuardianRegistry
/// @notice UUPS-upgradeable registry for guardian stake, review votes, slashing,
///         epoch rewards, and slash-appeal reserve. Skeleton only — subsequent
///         tasks fill in each function body. See
///         `docs/superpowers/plans/2026-04-20-guardian-review-lifecycle.md`.
contract GuardianRegistry is IGuardianRegistry, OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ── Constants ──
    uint256 public constant EPOCH_DURATION = 7 days;
    uint256 public constant MIN_COHORT_STAKE_AT_OPEN = 50_000 * 1e18;
    uint256 public constant MAX_APPROVERS_PER_PROPOSAL = 100;
    uint256 public constant SWEEP_DELAY = 12 weeks;
    uint256 public constant LATE_VOTE_LOCKOUT_BPS = 1000;
    uint256 public constant MAX_REFUND_PER_EPOCH_BPS = 2000;
    uint256 public constant DEADMAN_UNPAUSE_DELAY = 7 days;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ── Storage — see spec §3.1 for layout ──
    struct Guardian {
        uint128 stakedAmount;
        uint64 stakedAt;
        uint64 unstakeRequestedAt;
        uint256 agentId;
    }

    mapping(address => Guardian) internal _guardians;
    uint256 public totalGuardianStake;
    uint256 public activeGuardianCount;

    struct OwnerStake {
        uint128 stakedAmount;
        uint64 unstakeRequestedAt;
        address owner;
    }

    mapping(address vault => OwnerStake) internal _ownerStakes;

    struct PreparedOwnerStake {
        uint128 amount;
        uint64 preparedAt;
        bool bound;
    }

    mapping(address owner => PreparedOwnerStake) internal _prepared;

    struct Review {
        bool opened;
        bool resolved;
        bool blocked;
        bool cohortTooSmall;
        uint128 totalStakeAtOpen;
        uint128 approveStakeWeight;
        uint128 blockStakeWeight;
    }

    mapping(uint256 => Review) internal _reviews;
    mapping(uint256 => mapping(address => GuardianVoteType)) internal _votes;
    mapping(uint256 => mapping(address => uint128)) internal _voteStake;
    mapping(uint256 => address[]) internal _approvers;
    mapping(uint256 => address[]) internal _blockers;
    mapping(uint256 => mapping(address => uint256)) internal _approverIndex;
    mapping(uint256 => mapping(address => uint256)) internal _blockerIndex;

    struct EmergencyReview {
        bytes32 callsHash;
        uint64 reviewEnd;
        uint128 totalStakeAtOpen;
        uint128 blockStakeWeight;
        bool resolved;
        bool blocked;
    }

    mapping(uint256 => EmergencyReview) internal _emergencyReviews;
    mapping(uint256 => mapping(address => bool)) internal _emergencyBlockVotes;

    // Epoch rewards
    uint256 public epochGenesis;
    mapping(uint256 => uint256) public epochBudget;
    mapping(uint256 => uint256) public epochTotalBlockWeight;
    mapping(uint256 => mapping(address => uint256)) public epochGuardianBlockWeight;
    mapping(uint256 => mapping(address => bool)) public epochRewardClaimed;

    // Pending burn
    mapping(address => uint256) internal _pendingBurn;

    // Pause state
    bool public paused;
    uint64 public pausedAt;

    // Slash appeal
    uint256 public slashAppealReserve;
    mapping(uint256 => uint256) public refundedInEpoch;

    // Parameters
    uint256 public minGuardianStake;
    uint256 public minOwnerStake;
    uint256 public ownerStakeTvlBps;
    uint256 public coolDownPeriod;
    uint256 public reviewPeriod;
    uint256 public blockQuorumBps;

    // Pending parameter changes (timelocked — Task 24)
    struct PendingChange {
        uint256 newValue;
        uint64 effectiveAt;
        bool exists;
    }

    mapping(bytes32 => PendingChange) internal _pendingChanges;
    uint256 public parameterChangeDelay;

    // Privileged addresses
    address public governor;
    address public factory;
    address public minter;
    IERC20 public wood;

    // ── Initializer ──
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        address governor_,
        address factory_,
        address wood_,
        uint256 minGuardianStake_,
        uint256 minOwnerStake_,
        uint256 ownerStakeTvlBps_,
        uint256 coolDownPeriod_,
        uint256 reviewPeriod_,
        uint256 blockQuorumBps_
    ) external initializer {
        if (owner_ == address(0) || governor_ == address(0) || factory_ == address(0) || wood_ == address(0)) {
            revert ZeroAddress();
        }

        __Ownable_init(owner_);

        governor = governor_;
        factory = factory_;
        wood = IERC20(wood_);
        minGuardianStake = minGuardianStake_;
        minOwnerStake = minOwnerStake_;
        ownerStakeTvlBps = ownerStakeTvlBps_;
        coolDownPeriod = coolDownPeriod_;
        reviewPeriod = reviewPeriod_;
        blockQuorumBps = blockQuorumBps_;
        parameterChangeDelay = 24 hours; // default; timelocked setter in Task 24
        epochGenesis = block.timestamp;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Guardian fns ──
    /// @inheritdoc IGuardianRegistry
    /// @dev Idempotent top-up: on first stake records `agentId` and activates
    ///      the guardian; on subsequent calls the `agentId` arg is ignored.
    function stakeAsGuardian(uint256 amount, uint256 agentId) external nonReentrant {
        if (paused) revert ProtocolPaused();

        Guardian storage g = _guardians[msg.sender];
        uint256 newTotal = uint256(g.stakedAmount) + amount;
        if (newTotal < minGuardianStake) revert InsufficientStake();

        wood.safeTransferFrom(msg.sender, address(this), amount);

        bool wasInactive = g.stakedAmount == 0;
        g.stakedAmount = uint128(newTotal);
        if (wasInactive) {
            g.stakedAt = uint64(block.timestamp);
            g.agentId = agentId; // recorded once; ignored on top-ups
            activeGuardianCount += 1;
        }
        totalGuardianStake += amount;

        emit GuardianStaked(msg.sender, amount, agentId);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Immediately revokes voting power by zeroing the guardian's contribution to
    ///      `totalGuardianStake` and decrementing `activeGuardianCount`. WOOD stays in
    ///      the registry until `claimUnstakeGuardian` after `coolDownPeriod`.
    function requestUnstakeGuardian() external {
        Guardian storage g = _guardians[msg.sender];
        if (g.stakedAmount == 0) revert NoActiveStake();
        if (g.unstakeRequestedAt != 0) revert UnstakeAlreadyRequested();

        g.unstakeRequestedAt = uint64(block.timestamp);
        totalGuardianStake -= g.stakedAmount;
        activeGuardianCount -= 1;

        emit GuardianUnstakeRequested(msg.sender, block.timestamp);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Reverses `requestUnstakeGuardian`: restores voting power and active count.
    function cancelUnstakeGuardian() external {
        Guardian storage g = _guardians[msg.sender];
        if (g.unstakeRequestedAt == 0) revert UnstakeNotRequested();

        g.unstakeRequestedAt = 0;
        totalGuardianStake += g.stakedAmount;
        activeGuardianCount += 1;

        emit GuardianUnstakeCancelled(msg.sender);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev After `coolDownPeriod` from `unstakeRequestedAt`, releases WOOD and
    ///      deregisters the guardian entirely (struct deleted — agentId can differ on
    ///      a subsequent re-stake).
    function claimUnstakeGuardian() external nonReentrant {
        Guardian storage g = _guardians[msg.sender];
        if (g.unstakeRequestedAt == 0) revert UnstakeNotRequested();
        if (block.timestamp < uint256(g.unstakeRequestedAt) + coolDownPeriod) {
            revert CooldownNotElapsed();
        }

        uint256 amount = g.stakedAmount;
        delete _guardians[msg.sender];

        wood.safeTransfer(msg.sender, amount);

        emit GuardianUnstakeClaimed(msg.sender, amount);
    }

    function voteOnProposal(uint256, GuardianVoteType) external {
        revert();
    }

    // ── Owner fns ──
    /// @inheritdoc IGuardianRegistry
    /// @dev Pulls WOOD into the registry under `_prepared[msg.sender]`. At prepare time
    ///      we don't yet know the target vault's TVL-scaled bond, so only the floor
    ///      (`minOwnerStake`) is enforced here. The factory checks `requiredOwnerBond`
    ///      at `bindOwnerStake` time.
    function prepareOwnerStake(uint256 amount) external nonReentrant {
        if (amount < minOwnerStake) revert InsufficientStake();

        PreparedOwnerStake storage p = _prepared[msg.sender];
        // Allow re-prepare only after a previous prepared stake was bound (slot consumed).
        if (p.amount != 0 && !p.bound) revert PreparedStakeAlreadyExists();

        wood.safeTransferFrom(msg.sender, address(this), amount);

        _prepared[msg.sender] =
            PreparedOwnerStake({amount: uint128(amount), preparedAt: uint64(block.timestamp), bound: false});

        emit OwnerStakePrepared(msg.sender, amount);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Refunds an unbound prepared stake. Reverts if the slot has already been
    ///      bound to a vault (use the owner-unstake flow in that case).
    function cancelPreparedStake() external nonReentrant {
        PreparedOwnerStake storage p = _prepared[msg.sender];
        if (p.amount == 0 || p.bound) revert PreparedStakeNotFound();

        uint256 amount = p.amount;
        delete _prepared[msg.sender];

        wood.safeTransfer(msg.sender, amount);

        emit PreparedStakeCancelled(msg.sender, amount);
    }

    function requestUnstakeOwner(address) external {
        revert();
    }

    function claimUnstakeOwner(address) external {
        revert();
    }

    // ── Factory-only ──
    function bindOwnerStake(address, address) external {
        revert();
    }

    function transferOwnerStakeSlot(address, address) external {
        revert();
    }

    // ── Governor-only ──
    function openEmergencyReview(uint256, bytes32) external {
        revert();
    }

    // ── Permissionless ──
    function openReview(uint256) external {
        revert();
    }

    function resolveReview(uint256) external returns (bool) {
        revert();
    }

    function resolveEmergencyReview(uint256) external returns (bool) {
        revert();
    }

    function voteBlockEmergencySettle(uint256) external {
        revert();
    }

    function flushBurn() external {
        revert();
    }

    function sweepUnclaimed(uint256) external {
        revert();
    }

    // ── Epoch rewards ──
    function fundEpoch(uint256, uint256) external {
        revert();
    }

    function claimEpochReward(uint256) external {
        revert();
    }

    // ── Slash appeal ──
    function fundSlashAppealReserve(uint256) external {
        revert();
    }

    function refundSlash(address, uint256) external {
        revert();
    }

    // ── Pause ──
    function pause() external {
        revert();
    }

    function unpause() external {
        revert();
    }

    // ── Parameter setters (timelocked — Task 24) ──
    function setMinGuardianStake(uint256) external {
        revert();
    }

    function setMinOwnerStake(uint256) external {
        revert();
    }

    function setOwnerStakeTvlBps(uint256) external {
        revert();
    }

    function setCoolDownPeriod(uint256) external {
        revert();
    }

    function setReviewPeriod(uint256) external {
        revert();
    }

    function setBlockQuorumBps(uint256) external {
        revert();
    }

    function setMinter(address) external {
        revert();
    }

    // ── Views (minimal now; full impl in later tasks) ──
    function guardianStake(address g) external view returns (uint256) {
        return _guardians[g].stakedAmount;
    }

    function ownerStake(address v) external view returns (uint256) {
        return _ownerStakes[v].stakedAmount;
    }

    function isActiveGuardian(address g) external view returns (bool) {
        return _guardians[g].stakedAmount > 0 && _guardians[g].unstakeRequestedAt == 0;
    }

    function hasOwnerStake(address v) external view returns (bool) {
        return _ownerStakes[v].stakedAmount > 0;
    }

    function preparedStakeOf(address o) external view returns (uint256) {
        return _prepared[o].amount;
    }

    function canCreateVault(address o) external view returns (bool) {
        return _prepared[o].amount >= minOwnerStake && !_prepared[o].bound;
    }

    function requiredOwnerBond(address) external view returns (uint256) {
        return minOwnerStake; // Task 10 adds TVL scaling
    }

    function currentEpoch() external view returns (uint256) {
        return (block.timestamp - epochGenesis) / EPOCH_DURATION;
    }

    function pendingEpochReward(address, uint256) external view returns (uint256) {
        return 0; // Task 20
    }
}
