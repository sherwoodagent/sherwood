// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IGuardianRegistry} from "./interfaces/IGuardianRegistry.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @dev Minimal governor surface consumed by the registry. Intentionally a
///      narrow stub so that GuardianRegistry does not depend on the full
///      ISyndicateGovernor ABI (which would pull in the entire StrategyProposal
///      struct along with the rest of the governor's types).
///
///      `ProposalView` carries only the review-window timestamps and vault; the
///      governor exposes a dedicated `getProposalView(uint256)` that returns a
///      matching-shape struct. Using a dedicated view (rather than decoding the
///      full `StrategyProposal`) keeps ABI compatibility explicit — the positions
///      of `voteEnd`/`reviewEnd` inside `StrategyProposal` differ from this shape.
interface IGovernorMinimal {
    struct ProposalView {
        uint256 voteEnd;
        uint256 reviewEnd;
        address vault;
    }

    function getActiveProposal(address vault) external view returns (uint256);
    function getProposalView(uint256 proposalId) external view returns (ProposalView memory);
}

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

    // ── Parameter timelock ──
    bytes32 public constant PARAM_MIN_GUARDIAN_STAKE = keccak256("minGuardianStake");
    bytes32 public constant PARAM_MIN_OWNER_STAKE = keccak256("minOwnerStake");
    bytes32 public constant PARAM_OWNER_STAKE_TVL_BPS = keccak256("ownerStakeTvlBps");
    bytes32 public constant PARAM_COOLDOWN = keccak256("coolDownPeriod");
    bytes32 public constant PARAM_REVIEW_PERIOD = keccak256("reviewPeriod");
    bytes32 public constant PARAM_BLOCK_QUORUM_BPS = keccak256("blockQuorumBps");

    uint256 public constant MIN_PARAM_CHANGE_DELAY = 6 hours;
    uint256 public constant MAX_PARAM_CHANGE_DELAY = 7 days;

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

    /// @dev Reserved storage for future upgrades. Shrink by 1 when adding a
    ///      new storage slot. Matches the pattern on SyndicateGovernor /
    ///      SyndicateFactory / SyndicateVault.
    uint256[50] private __gap;

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

    // ── Modifiers ──
    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    modifier onlyGovernor() {
        if (msg.sender != governor) revert NotGovernor();
        _;
    }

    modifier onlyMinterOrOwner() {
        if (msg.sender != minter && msg.sender != owner()) revert NotMinterOrOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ProtocolPaused();
        _;
    }

    // ── Guardian fns ──
    /// @inheritdoc IGuardianRegistry
    /// @dev Idempotent top-up: on first stake records `agentId` and activates
    ///      the guardian; on subsequent calls the `agentId` arg is ignored.
    function stakeAsGuardian(uint256 amount, uint256 agentId) external nonReentrant {
        // Stake intentionally not gated by pause: guardians must be able to
        // manage their position (stake/unstake/claim) even during an incident.
        Guardian storage g = _guardians[msg.sender];
        // Bug A fix: a guardian with a pending unstake request is NOT active
        // (see `_isActiveGuardian`), so letting them top up would grow
        // `totalGuardianStake` without creating votable weight — quorum
        // denominator would outrun the real cohort. Force them to cancel the
        // unstake first.
        if (g.unstakeRequestedAt != 0) revert UnstakeAlreadyRequested();
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
        // Bug B fix: if the guardian was slashed between `requestUnstakeGuardian`
        // and now, `stakedAmount == 0` but `unstakeRequestedAt` still points at
        // the original request. "Cancelling" here would increment
        // `activeGuardianCount` without restoring any stake, producing a ghost
        // guardian. Nothing to restore → revert.
        if (g.stakedAmount == 0) revert NoActiveStake();

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

    /// @inheritdoc IGuardianRegistry
    /// @dev First-vote path. Requires `openReview` to have been called and
    ///      `voteEnd <= now < reviewEnd`. Snapshots the caller's current
    ///      `guardianStake` into `_voteStake[proposalId][caller]` and adds it
    ///      to the chosen side's tally. Approvers are capped at
    ///      `MAX_APPROVERS_PER_PROPOSAL`; Blockers are uncapped. Vote-change
    ///      semantics are added in a later task — any existing vote currently
    ///      reverts.
    function voteOnProposal(uint256 proposalId, GuardianVoteType support) external whenNotPaused {
        if (support == GuardianVoteType.None) revert();

        Review storage r = _reviews[proposalId];
        if (!r.opened) revert ReviewNotOpen();

        IGovernorMinimal.ProposalView memory p = IGovernorMinimal(governor).getProposalView(proposalId);
        if (block.timestamp < p.voteEnd || block.timestamp >= p.reviewEnd) revert ReviewNotOpen();

        if (!_isActiveGuardian(msg.sender)) revert NotActiveGuardian();

        GuardianVoteType existing = _votes[proposalId][msg.sender];
        if (existing == support) revert NoVoteChange();

        if (existing == GuardianVoteType.None) {
            // First vote — snapshot stake and push onto chosen side.
            uint128 weight = _guardians[msg.sender].stakedAmount;
            _voteStake[proposalId][msg.sender] = weight;

            if (support == GuardianVoteType.Approve) {
                _pushApprover(proposalId, msg.sender);
                r.approveStakeWeight += weight;
            } else {
                _pushBlocker(proposalId, msg.sender);
                r.blockStakeWeight += weight;
            }
            _votes[proposalId][msg.sender] = support;
            emit GuardianVoteCast(proposalId, msg.sender, support, weight);
        } else {
            // Vote-change: must be before the late lockout window. The final
            // `LATE_VOTE_LOCKOUT_BPS` of `reviewPeriod` is locked to prevent
            // last-minute flips that would make honest early Approvers
            // strictly worse off than abstainers.
            uint256 lockoutStart = p.reviewEnd - (reviewPeriod * LATE_VOTE_LOCKOUT_BPS) / 10_000;
            if (block.timestamp >= lockoutStart) revert VoteChangeLockedOut();

            uint128 weight = _voteStake[proposalId][msg.sender]; // preserved snapshot
            if (existing == GuardianVoteType.Approve) {
                // Approve → Block: blocks uncapped, always succeeds.
                _removeApprover(proposalId, msg.sender);
                r.approveStakeWeight -= weight;
                _pushBlocker(proposalId, msg.sender);
                r.blockStakeWeight += weight;
            } else {
                // Block → Approve: check Approve cap FIRST without mutating
                // the old side (check-first-then-apply). If full, revert
                // NewSideFull; caller retains their Block vote.
                if (_approvers[proposalId].length >= MAX_APPROVERS_PER_PROPOSAL) revert NewSideFull();
                _removeBlocker(proposalId, msg.sender);
                r.blockStakeWeight -= weight;
                _pushApprover(proposalId, msg.sender); // guaranteed to fit (cap checked above)
                r.approveStakeWeight += weight;
            }
            _votes[proposalId][msg.sender] = support;
            emit GuardianVoteChanged(proposalId, msg.sender, existing, support);
        }
    }

    // ── Internal vote helpers ──
    function _pushApprover(uint256 proposalId, address g) private {
        if (_approvers[proposalId].length >= MAX_APPROVERS_PER_PROPOSAL) {
            emit ApproverCapReached(proposalId);
            revert NewSideFull();
        }
        _approvers[proposalId].push(g);
        _approverIndex[proposalId][g] = _approvers[proposalId].length; // 1-indexed
    }

    function _pushBlocker(uint256 proposalId, address g) private {
        _blockers[proposalId].push(g);
        _blockerIndex[proposalId][g] = _blockers[proposalId].length; // 1-indexed
    }

    /// @dev Swap-and-pop removal of `g` from `_approvers[proposalId]`, keeping
    ///      `_approverIndex` consistent. Expects `g` to be present (idx1 > 0).
    function _removeApprover(uint256 proposalId, address g) private {
        uint256 idx1 = _approverIndex[proposalId][g];
        uint256 idx = idx1 - 1;
        address[] storage arr = _approvers[proposalId];
        address last = arr[arr.length - 1];
        if (last != g) {
            arr[idx] = last;
            _approverIndex[proposalId][last] = idx1;
        }
        arr.pop();
        delete _approverIndex[proposalId][g];
    }

    /// @dev Mirror of `_removeApprover` for blockers.
    function _removeBlocker(uint256 proposalId, address g) private {
        uint256 idx1 = _blockerIndex[proposalId][g];
        uint256 idx = idx1 - 1;
        address[] storage arr = _blockers[proposalId];
        address last = arr[arr.length - 1];
        if (last != g) {
            arr[idx] = last;
            _blockerIndex[proposalId][last] = idx1;
        }
        arr.pop();
        delete _blockerIndex[proposalId][g];
    }

    function _isActiveGuardian(address g) private view returns (bool) {
        Guardian storage gs = _guardians[g];
        return gs.stakedAmount > 0 && gs.unstakeRequestedAt == 0;
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

    /// @inheritdoc IGuardianRegistry
    /// @dev Vault owner signals intent to exit. Blocked while the vault has an
    ///      active proposal (any governor state between `Pending` and `Executed`)
    ///      to prevent rage-quit around malicious executions. Immediately stamps
    ///      `unstakeRequestedAt`; WOOD stays escrowed until `claimUnstakeOwner`.
    function requestUnstakeOwner(address vault) external {
        OwnerStake storage s = _ownerStakes[vault];
        if (s.owner != msg.sender || s.stakedAmount == 0) revert NoActiveStake();
        if (s.unstakeRequestedAt != 0) revert UnstakeAlreadyRequested();
        if (IGovernorMinimal(governor).getActiveProposal(vault) != 0) {
            revert VaultHasActiveProposal();
        }

        s.unstakeRequestedAt = uint64(block.timestamp);

        emit OwnerUnstakeRequested(vault, block.timestamp);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev After `coolDownPeriod` from `unstakeRequestedAt`, releases WOOD to the
    ///      recorded owner and deletes `_ownerStakes[vault]` entirely — the vault
    ///      then enters grace-period state (`ownerStaked == false`). New proposals
    ///      cannot be created until owner re-binds a fresh stake via the factory.
    function claimUnstakeOwner(address vault) external nonReentrant {
        OwnerStake storage s = _ownerStakes[vault];
        if (s.owner != msg.sender || s.stakedAmount == 0) revert NoActiveStake();
        if (s.unstakeRequestedAt == 0) revert UnstakeNotRequested();
        if (block.timestamp < uint256(s.unstakeRequestedAt) + coolDownPeriod) {
            revert CooldownNotElapsed();
        }

        uint256 amount = s.stakedAmount;
        address recipient = s.owner;
        delete _ownerStakes[vault];

        wood.safeTransfer(recipient, amount);

        emit OwnerUnstakeClaimed(vault, recipient, amount);
    }

    // ── Factory-only ──
    /// @inheritdoc IGuardianRegistry
    /// @dev Consumes `_prepared[owner]` and binds it to `_ownerStakes[vault]`. Called
    ///      by `SyndicateFactory.createSyndicate` after the vault address is known.
    ///      Reverts if the prepared amount is below `requiredOwnerBond(vault)` — at
    ///      factory-creation time `totalAssets()` is 0, so only the floor applies.
    function bindOwnerStake(address owner_, address vault) external onlyFactory nonReentrant {
        PreparedOwnerStake storage p = _prepared[owner_];
        if (p.amount == 0 || p.bound) revert PreparedStakeNotFound();
        if (p.amount < requiredOwnerBond(vault)) revert OwnerBondInsufficient();

        _ownerStakes[vault] = OwnerStake({stakedAmount: p.amount, unstakeRequestedAt: 0, owner: owner_});
        p.bound = true;

        emit OwnerStakeBound(owner_, vault, p.amount);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Reassigns `_ownerStakes[vault]` to `newOwner`'s prepared stake after the
    ///      previous owner's stake has been slashed or fully unstaked (guarded by
    ///      `stakedAmount == 0`). `newOwner` must have called `prepareOwnerStake`
    ///      with ≥ `requiredOwnerBond(vault)`.
    function transferOwnerStakeSlot(address vault, address newOwner) external onlyFactory nonReentrant {
        OwnerStake storage existing = _ownerStakes[vault];
        address oldOwner = existing.owner;
        if (existing.stakedAmount != 0) revert VaultHasActiveProposal();

        PreparedOwnerStake storage p = _prepared[newOwner];
        if (p.amount == 0 || p.bound) revert PreparedStakeNotFound();
        if (p.amount < requiredOwnerBond(vault)) revert OwnerBondInsufficient();

        _ownerStakes[vault] = OwnerStake({stakedAmount: p.amount, unstakeRequestedAt: 0, owner: newOwner});
        p.bound = true;

        emit OwnerStakeSlotTransferred(vault, oldOwner, newOwner);
    }

    // ── Governor-only ──
    /// @inheritdoc IGuardianRegistry
    /// @dev Opens a block-only emergency review window. Unlike the standard
    ///      review path there is no separate keeper — `totalStakeAtOpen` is
    ///      snapshotted at open time from the live `totalGuardianStake`.
    ///      Called by the governor when an emergency settle is staged
    ///      (spec §3.1).
    function openEmergencyReview(uint256 proposalId, bytes32 callsHash) external onlyGovernor {
        EmergencyReview storage er = _emergencyReviews[proposalId];
        uint64 newReviewEnd = uint64(block.timestamp + reviewPeriod);
        er.callsHash = callsHash;
        er.reviewEnd = newReviewEnd;
        er.totalStakeAtOpen = uint128(totalGuardianStake);
        emit EmergencyReviewOpened(proposalId, callsHash, newReviewEnd);
    }

    // ── Permissionless ──
    /// @inheritdoc IGuardianRegistry
    /// @dev Permissionless keeper entrypoint. Callable once
    ///      `block.timestamp >= proposal.voteEnd`. Snapshots
    ///      `totalGuardianStake` into `_reviews[id].totalStakeAtOpen` and
    ///      marks the review opened. If the snapshot is below
    ///      `MIN_COHORT_STAKE_AT_OPEN`, flags the review as
    ///      `cohortTooSmall`; `resolveReview` will then short-circuit to
    ///      `blocked = false` regardless of any votes (cold-start fallback).
    ///      Idempotent: subsequent calls are no-ops.
    function openReview(uint256 proposalId) external whenNotPaused {
        Review storage r = _reviews[proposalId];
        if (r.opened) return; // idempotent

        uint256 ve = IGovernorMinimal(governor).getProposalView(proposalId).voteEnd;
        if (ve == 0 || block.timestamp < ve) revert ReviewNotOpen();

        uint128 totalAtOpen = uint128(totalGuardianStake);
        r.opened = true;
        r.totalStakeAtOpen = totalAtOpen;
        if (totalAtOpen < MIN_COHORT_STAKE_AT_OPEN) {
            r.cohortTooSmall = true;
            emit CohortTooSmallToReview(proposalId, totalAtOpen);
        } else {
            emit ReviewOpened(proposalId, totalAtOpen);
        }
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Permissionless. Idempotent — once resolved, returns the cached
    ///      `blocked` flag without re-slashing. Requires
    ///      `block.timestamp >= reviewEnd`. Short-circuits to `false` when
    ///      `!opened` (no activity) or `cohortTooSmall` (cold-start fallback).
    ///      Otherwise: `blocked = (blockStakeWeight * 10_000 >= blockQuorumBps * totalStakeAtOpen)`.
    ///      CEI: sets `resolved`/`blocked` flags BEFORE any token transfer.
    ///      When blocked, slashes all approvers' stake to BURN_ADDRESS and
    ///      credits blockers' weights to the current epoch's block-weight
    ///      tallies (spec §3.1, epoch attribution uses resolve-time
    ///      `block.timestamp`).
    function resolveReview(uint256 proposalId) external nonReentrant whenNotPaused returns (bool) {
        IGovernorMinimal.ProposalView memory p = IGovernorMinimal(governor).getProposalView(proposalId);
        if (p.reviewEnd == 0 || block.timestamp < p.reviewEnd) revert ReviewNotReadyForResolve();

        Review storage r = _reviews[proposalId];
        if (r.resolved) return r.blocked; // idempotent
        if (!r.opened) {
            r.resolved = true;
            emit ReviewResolved(proposalId, false, 0);
            return false;
        }
        if (r.cohortTooSmall) {
            r.resolved = true;
            emit ReviewResolved(proposalId, false, 0);
            return false;
        }

        bool blocked_ = (uint256(r.blockStakeWeight) * 10_000 >= blockQuorumBps * uint256(r.totalStakeAtOpen));

        // CEI: commit state BEFORE any external transfer.
        r.resolved = true;
        r.blocked = blocked_;

        uint256 slashed;
        if (blocked_) {
            slashed = _slashApprovers(proposalId);
            _attributeBlockWeightToEpoch(proposalId);
        }

        emit ReviewResolved(proposalId, blocked_, slashed);
        return blocked_;
    }

    /// @dev Zero each approver's stake, accumulate total, decrement aggregate
    ///      counters, then attempt one `wood.transfer(BURN, total)`. If the
    ///      transfer reverts or returns false, the amount is queued in
    ///      `_pendingBurn[address(this)]` for retry via `flushBurn`.
    function _slashApprovers(uint256 proposalId) private returns (uint256 total) {
        address[] storage approvers = _approvers[proposalId];
        uint256 n = approvers.length;
        for (uint256 i = 0; i < n; i++) {
            address a = approvers[i];
            Guardian storage gs = _guardians[a];
            uint256 amt = gs.stakedAmount;
            if (amt == 0) continue;
            total += amt;
            gs.stakedAmount = 0;
            // If the approver was still active (hadn't requested unstake), the
            // aggregate counters include their stake → remove from both. If
            // they'd already requested unstake, `totalGuardianStake` and
            // `activeGuardianCount` were already decremented at request time.
            if (gs.unstakeRequestedAt == 0) {
                totalGuardianStake -= amt;
                activeGuardianCount -= 1;
            } else {
                // Defense in depth for Bug B: a slashed guardian keeps no
                // stake — there's nothing for cancelUnstake to restore, so
                // clear the timestamp too. `cancelUnstakeGuardian` now also
                // checks `stakedAmount != 0`, but clearing here keeps the
                // struct in a fully-consistent state for future views.
                gs.unstakeRequestedAt = 0;
            }
        }

        if (total == 0) return 0;

        // Single burn transfer wrapped in try/catch. A malicious / broken WOOD
        // that reverts or returns false on transfer to BURN_ADDRESS falls
        // through to the pull-based `flushBurn` fallback.
        try IERC20(wood).transfer(BURN_ADDRESS, total) returns (bool ok) {
            if (!ok) {
                _pendingBurn[address(this)] += total;
                emit PendingBurnRecorded(total);
            }
        } catch {
            _pendingBurn[address(this)] += total;
            emit PendingBurnRecorded(total);
        }
    }

    /// @dev Credits each blocker's snapshot weight to
    ///      `epochGuardianBlockWeight[currentEpoch][g]` and bumps
    ///      `epochTotalBlockWeight[currentEpoch]`. Epoch is resolved at the
    ///      resolve-time `block.timestamp` (not reviewEnd), matching the spec.
    function _attributeBlockWeightToEpoch(uint256 proposalId) private {
        uint256 epochId = (block.timestamp - epochGenesis) / EPOCH_DURATION;
        address[] storage blockers = _blockers[proposalId];
        uint256 n = blockers.length;
        uint256 epochTotalDelta;
        for (uint256 i = 0; i < n; i++) {
            address b = blockers[i];
            uint256 w = _voteStake[proposalId][b];
            if (w == 0) continue;
            epochGuardianBlockWeight[epochId][b] += w;
            epochTotalDelta += w;
        }
        if (epochTotalDelta != 0) {
            epochTotalBlockWeight[epochId] += epochTotalDelta;
        }
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Permissionless. Idempotent. Requires
    ///      `block.timestamp >= reviewEnd`. If the cohort was empty at open
    ///      (`totalStakeAtOpen == 0`), short-circuits to `false`. Otherwise:
    ///      `blocked = (blockStakeWeight * 10_000 >= blockQuorumBps * totalStakeAtOpen)`.
    ///      CEI: commits `resolved`/`blocked` flags BEFORE any transfer. On
    ///      block, slashes the vault owner (spec §3.1 emergency path).
    function resolveEmergencyReview(uint256 proposalId) external nonReentrant whenNotPaused returns (bool) {
        EmergencyReview storage er = _emergencyReviews[proposalId];
        if (er.reviewEnd == 0 || block.timestamp < er.reviewEnd) revert ReviewNotReadyForResolve();
        if (er.resolved) return er.blocked; // idempotent
        if (er.totalStakeAtOpen == 0) {
            er.resolved = true;
            emit EmergencyReviewResolved(proposalId, false, 0);
            return false;
        }

        bool blocked_ = (uint256(er.blockStakeWeight) * 10_000 >= blockQuorumBps * uint256(er.totalStakeAtOpen));

        // CEI: commit state BEFORE external transfer.
        er.resolved = true;
        er.blocked = blocked_;

        uint256 slashed;
        if (blocked_) {
            slashed = _slashOwner(proposalId);
        }

        emit EmergencyReviewResolved(proposalId, blocked_, slashed);
        return blocked_;
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Active-guardian-only. Block-only side (no Approve pool for
    ///      emergency reviews). One vote per guardian — double-votes revert.
    ///      Weight is the caller's current `guardianStake` at call time.
    function voteBlockEmergencySettle(uint256 proposalId) external whenNotPaused {
        EmergencyReview storage er = _emergencyReviews[proposalId];
        if (er.reviewEnd == 0 || block.timestamp >= er.reviewEnd) revert ReviewNotOpen();
        if (!_isActiveGuardian(msg.sender)) revert NotActiveGuardian();
        if (_emergencyBlockVotes[proposalId][msg.sender]) revert AlreadyVoted();

        uint128 weight = _guardians[msg.sender].stakedAmount;
        _emergencyBlockVotes[proposalId][msg.sender] = true;
        er.blockStakeWeight += weight;

        emit EmergencyBlockVoteCast(proposalId, msg.sender, weight);
    }

    /// @dev Slashes the vault owner's stake when an emergency review resolves
    ///      as blocked. Looks up the vault via `governor.getProposal().vault`,
    ///      zeros `_ownerStakes[vault].stakedAmount`, and attempts a single
    ///      `wood.transfer(BURN, amt)` with the same try/catch fallback as
    ///      the approver-slash path.
    function _slashOwner(uint256 proposalId) private returns (uint256 amt) {
        address vault = IGovernorMinimal(governor).getProposalView(proposalId).vault;
        OwnerStake storage s = _ownerStakes[vault];
        amt = s.stakedAmount;
        if (amt == 0) return 0;
        s.stakedAmount = 0;

        try IERC20(wood).transfer(BURN_ADDRESS, amt) returns (bool ok) {
            if (!ok) {
                _pendingBurn[address(this)] += amt;
                emit PendingBurnRecorded(amt);
            }
        } catch {
            _pendingBurn[address(this)] += amt;
            emit PendingBurnRecorded(amt);
        }
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Permissionless retry of a stuck slash burn. Reads
    ///      `_pendingBurn[address(this)]`, zeros it, then `safeTransfer`s to
    ///      `BURN_ADDRESS`. `safeTransfer` reverts on failure — if the WOOD
    ///      token is still broken the whole tx reverts and the pending amount
    ///      stays queued (state update and transfer are atomic within the
    ///      `nonReentrant` guard). No-op when queue is empty.
    function flushBurn() external nonReentrant whenNotPaused {
        uint256 amt = _pendingBurn[address(this)];
        if (amt == 0) return;
        _pendingBurn[address(this)] = 0;
        wood.safeTransfer(BURN_ADDRESS, amt);
        emit BurnFlushed(amt);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Permissionless. After `SWEEP_DELAY` (12 weeks) beyond
    ///      `epochEnd`, moves any residual `epochBudget[epochId]` into the
    ///      current epoch so late-arriving guardians can still claim against
    ///      a pool. No-op (no revert) when residual is zero, so the
    ///      entrypoint remains callable without gating even if a keeper
    ///      races a manual sweep.
    function sweepUnclaimed(uint256 epochId) external nonReentrant whenNotPaused {
        uint256 epochEnd = epochGenesis + (epochId + 1) * EPOCH_DURATION;
        if (block.timestamp < epochEnd + SWEEP_DELAY) revert SweepTooEarly();
        uint256 residual = epochBudget[epochId];
        if (residual == 0) return;

        uint256 to = currentEpoch();
        epochBudget[epochId] = 0;
        epochBudget[to] += residual;
        emit EpochUnclaimedSwept(epochId, to, residual);
    }

    // ── Epoch rewards ──
    /// @inheritdoc IGuardianRegistry
    /// @dev Callable by owner or minter. Allowed for current and future
    ///      epochs. Past epochs can only be funded if
    ///      `epochBudget[epochId] == 0` — once any funding exists, the epoch
    ///      is effectively locked so already-claimed pro-rata splits cannot
    ///      be retroactively diluted.
    function fundEpoch(uint256 epochId, uint256 amount) external nonReentrant onlyMinterOrOwner {
        if (epochId < currentEpoch() && epochBudget[epochId] != 0) revert FundEpochLocked();

        wood.safeTransferFrom(msg.sender, address(this), amount);
        epochBudget[epochId] += amount;

        emit EpochFunded(epochId, msg.sender, amount);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Payout = `epochBudget * weight / totalWeight` evaluated against
    ///      the *remaining* budget and remaining total weight at claim time.
    ///      Decrementing both preserves pro-rata fairness regardless of
    ///      claim order (first claimer gets their full share even if other
    ///      guardians never claim). Reverts `NothingToClaim` on zero payout
    ///      (unfunded epoch, zero guardian weight, or rounding to zero) — so
    ///      guardians can come back and claim after a late `fundEpoch` for
    ///      the same past epoch. CEI: marks claimed and decrements budget +
    ///      total weight BEFORE transfer; the epoch's residual remains
    ///      accurate for `sweepUnclaimed`.
    function claimEpochReward(uint256 epochId) external nonReentrant whenNotPaused {
        if (epochId >= currentEpoch()) revert EpochNotEnded();
        if (epochRewardClaimed[epochId][msg.sender]) revert NothingToClaim();

        uint256 weight = epochGuardianBlockWeight[epochId][msg.sender];
        uint256 total = epochTotalBlockWeight[epochId];
        uint256 budget = epochBudget[epochId];
        uint256 payout = (weight == 0 || total == 0) ? 0 : (budget * weight) / total;
        if (payout == 0) revert NothingToClaim();

        epochRewardClaimed[epochId][msg.sender] = true;
        epochBudget[epochId] = budget - payout;
        epochTotalBlockWeight[epochId] = total - weight;

        wood.safeTransfer(msg.sender, payout);
        emit EpochRewardClaimed(epochId, msg.sender, payout);
    }

    // ── Slash appeal ──
    /// @inheritdoc IGuardianRegistry
    /// @dev Pulls WOOD from caller into `slashAppealReserve`. Owner-only —
    ///      this is an admin-capitalized safety net, not a permissionless
    ///      pool. Admin-only ops stay callable while paused.
    function fundSlashAppealReserve(uint256 amount) external nonReentrant onlyOwner {
        wood.safeTransferFrom(msg.sender, address(this), amount);
        slashAppealReserve += amount;
        emit SlashAppealReserveFunded(msg.sender, amount);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Per-epoch refund cap is `MAX_REFUND_PER_EPOCH_BPS` (20%) of the
    ///      CURRENT reserve size. Cumulative refunds per epoch are tracked
    ///      in `refundedInEpoch[epochId]`; cap resets with each new epoch.
    ///      Owner-only; admin-only ops stay callable while paused.
    function refundSlash(address recipient, uint256 amount) external nonReentrant onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();

        uint256 ep = currentEpoch();
        uint256 cap = (slashAppealReserve * MAX_REFUND_PER_EPOCH_BPS) / 10_000;
        if (refundedInEpoch[ep] + amount > cap) revert RefundCapExceeded();

        refundedInEpoch[ep] += amount;
        slashAppealReserve -= amount;

        wood.safeTransfer(recipient, amount);
        emit SlashAppealRefunded(recipient, amount, ep);
    }

    // ── Pause ──
    /// @inheritdoc IGuardianRegistry
    /// @dev Owner-only. Freezes review voting, claim, sweep, and flushBurn.
    ///      Stake/unstake paths and admin ops (fundEpoch, fundSlashAppealReserve,
    ///      refundSlash, parameter setters) stay callable so guardians can
    ///      exit and the owner can capitalize the reserve during an incident.
    function pause() external onlyOwner {
        paused = true;
        pausedAt = uint64(block.timestamp);
        emit Paused(msg.sender);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Owner can unpause at any time. After `DEADMAN_UNPAUSE_DELAY`
    ///      (7 days) has elapsed since `pausedAt`, any address can unpause
    ///      to prevent the protocol from being indefinitely frozen by an
    ///      absentee / compromised owner.
    function unpause() external {
        if (!paused) revert NotPausedOrDeadmanNotElapsed();
        bool deadman = msg.sender != owner();
        if (deadman && block.timestamp < uint256(pausedAt) + DEADMAN_UNPAUSE_DELAY) {
            revert NotPausedOrDeadmanNotElapsed();
        }
        paused = false;
        pausedAt = 0;
        emit Unpaused(msg.sender, deadman);
    }

    // ── Parameter setters (timelocked) ──

    /// @inheritdoc IGuardianRegistry
    /// @dev Validates bound at queue time; re-validation is implicit since
    ///      only owner can finalize and the bound check is stateless.
    function setMinGuardianStake(uint256 newValue) external onlyOwner {
        if (newValue < 1e18) revert InvalidParameter();
        _queueChange(PARAM_MIN_GUARDIAN_STAKE, newValue);
    }

    /// @inheritdoc IGuardianRegistry
    function setMinOwnerStake(uint256 newValue) external onlyOwner {
        if (newValue < 1_000 * 1e18) revert InvalidParameter();
        _queueChange(PARAM_MIN_OWNER_STAKE, newValue);
    }

    /// @inheritdoc IGuardianRegistry
    function setOwnerStakeTvlBps(uint256 newValue) external onlyOwner {
        if (newValue > 500) revert InvalidParameter();
        _queueChange(PARAM_OWNER_STAKE_TVL_BPS, newValue);
    }

    /// @inheritdoc IGuardianRegistry
    function setCoolDownPeriod(uint256 newValue) external onlyOwner {
        if (newValue < 1 days || newValue > 30 days) revert InvalidParameter();
        _queueChange(PARAM_COOLDOWN, newValue);
    }

    /// @inheritdoc IGuardianRegistry
    function setReviewPeriod(uint256 newValue) external onlyOwner {
        if (newValue < 6 hours || newValue > 7 days) revert InvalidParameter();
        _queueChange(PARAM_REVIEW_PERIOD, newValue);
    }

    /// @inheritdoc IGuardianRegistry
    function setBlockQuorumBps(uint256 newValue) external onlyOwner {
        if (newValue < 1_000 || newValue > 10_000) revert InvalidParameter();
        _queueChange(PARAM_BLOCK_QUORUM_BPS, newValue);
    }

    /// @notice Finalize a queued parameter change once `effectiveAt` has passed.
    /// @dev Owner-only. Writes the pending value into the target storage var,
    ///      clears the pending slot, emits `ParameterChangeFinalized`.
    function finalizeParameterChange(bytes32 paramKey) external onlyOwner {
        PendingChange storage change = _pendingChanges[paramKey];
        if (!change.exists) revert NoChangePending();
        if (block.timestamp < change.effectiveAt) revert ChangeNotReady();

        uint256 newValue = change.newValue;
        uint256 oldValue = _applyChange(paramKey, newValue);

        delete _pendingChanges[paramKey];
        emit ParameterChangeFinalized(paramKey, oldValue, newValue);
    }

    /// @notice Cancel a queued parameter change.
    function cancelParameterChange(bytes32 paramKey) external onlyOwner {
        if (!_pendingChanges[paramKey].exists) revert NoChangePending();
        delete _pendingChanges[paramKey];
        emit ParameterChangeCancelled(paramKey);
    }

    /// @notice Owner-instant minter rotation. Not timelocked: minter can only
    ///         top up the epoch treasury pool, so owner must be free to pick
    ///         and rotate implementations as the minter evolves.
    function setMinter(address newMinter) external onlyOwner {
        address old = minter;
        minter = newMinter;
        emit MinterUpdated(old, newMinter);
    }

    /// @notice View helper mirroring the governor-param pattern.
    function getPendingChange(bytes32 paramKey) external view returns (PendingChange memory) {
        return _pendingChanges[paramKey];
    }

    function _queueChange(bytes32 paramKey, uint256 newValue) private {
        if (_pendingChanges[paramKey].exists) revert ChangeAlreadyPending();
        uint64 effectiveAt = uint64(block.timestamp + parameterChangeDelay);
        _pendingChanges[paramKey] = PendingChange({newValue: newValue, effectiveAt: effectiveAt, exists: true});
        emit ParameterChangeQueued(paramKey, newValue, effectiveAt);
    }

    function _applyChange(bytes32 paramKey, uint256 newValue) private returns (uint256 old) {
        if (paramKey == PARAM_MIN_GUARDIAN_STAKE) {
            old = minGuardianStake;
            minGuardianStake = newValue;
        } else if (paramKey == PARAM_MIN_OWNER_STAKE) {
            old = minOwnerStake;
            minOwnerStake = newValue;
        } else if (paramKey == PARAM_OWNER_STAKE_TVL_BPS) {
            old = ownerStakeTvlBps;
            ownerStakeTvlBps = newValue;
        } else if (paramKey == PARAM_COOLDOWN) {
            old = coolDownPeriod;
            coolDownPeriod = newValue;
        } else if (paramKey == PARAM_REVIEW_PERIOD) {
            old = reviewPeriod;
            reviewPeriod = newValue;
        } else if (paramKey == PARAM_BLOCK_QUORUM_BPS) {
            old = blockQuorumBps;
            blockQuorumBps = newValue;
        } else {
            revert InvalidParameter();
        }
    }

    // ── Views (minimal now; full impl in later tasks) ──

    /// @inheritdoc IGuardianRegistry
    function getReviewState(uint256 proposalId)
        external
        view
        returns (bool opened, bool resolved, bool blocked, bool cohortTooSmall)
    {
        Review storage r = _reviews[proposalId];
        return (r.opened, r.resolved, r.blocked, r.cohortTooSmall);
    }

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

    /// @inheritdoc IGuardianRegistry
    /// @dev `max(minOwnerStake, totalAssets(vault) * ownerStakeTvlBps / 10_000)`.
    ///      With `ownerStakeTvlBps == 0` (V1 default) this degenerates to the floor
    ///      unconditionally. Task 10 adds dedicated tests for the scaled case.
    ///
    ///      Unit caveat: the formula mixes `minOwnerStake` (WOOD, 18 decimals) with
    ///      `totalAssets()` (vault asset decimals — 6 for USDC). For vaults whose
    ///      underlying is 18-decimal the result is consistent; for 6-decimal assets
    ///      the scaled term is numerically 10^12 times too small and the floor will
    ///      dominate. The spec §3.1 writes the formula this way and the V1 default
    ///      (`bps = 0`) sidesteps the issue. Flagged for review before `bps` is ever
    ///      flipped on via the timelocked setter. See plan 2026-04-20 Task 10.
    function requiredOwnerBond(address vault) public view returns (uint256) {
        uint256 floor = minOwnerStake;
        if (ownerStakeTvlBps == 0) return floor;
        uint256 scaled = (IERC4626(vault).totalAssets() * ownerStakeTvlBps) / 10_000;
        return scaled > floor ? scaled : floor;
    }

    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - epochGenesis) / EPOCH_DURATION;
    }

    /// @notice Mirrors `claimEpochReward` payout computation. Returns 0 when
    ///         already claimed, epoch not yet ended, or the computed payout
    ///         rounds to zero — matching what `claimEpochReward` would
    ///         revert on.
    function pendingEpochReward(address guardian, uint256 epochId) external view returns (uint256) {
        if (epochId >= currentEpoch()) return 0;
        if (epochRewardClaimed[epochId][guardian]) return 0;

        uint256 weight = epochGuardianBlockWeight[epochId][guardian];
        uint256 total = epochTotalBlockWeight[epochId];
        if (weight == 0 || total == 0) return 0;
        return (epochBudget[epochId] * weight) / total;
    }
}
