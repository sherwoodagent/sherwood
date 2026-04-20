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
///      `ProposalView` carries only the review-window timestamps; the governor
///      stamps both at proposal creation time (see Task 25) and the registry
///      reads them to gate `openReview` / `voteOnProposal` / `resolveReview`.
interface IGovernorMinimal {
    struct ProposalView {
        uint256 voteEnd;
        uint256 reviewEnd;
    }

    function getActiveProposal(address vault) external view returns (uint256);
    function getProposal(uint256 proposalId) external view returns (ProposalView memory);
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

    // ── Modifiers ──
    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

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

    /// @inheritdoc IGuardianRegistry
    /// @dev First-vote path. Requires `openReview` to have been called and
    ///      `voteEnd <= now < reviewEnd`. Snapshots the caller's current
    ///      `guardianStake` into `_voteStake[proposalId][caller]` and adds it
    ///      to the chosen side's tally. Approvers are capped at
    ///      `MAX_APPROVERS_PER_PROPOSAL`; Blockers are uncapped. Vote-change
    ///      semantics are added in a later task — any existing vote currently
    ///      reverts.
    function voteOnProposal(uint256 proposalId, GuardianVoteType support) external {
        if (paused) revert ProtocolPaused();
        if (support == GuardianVoteType.None) revert();

        Review storage r = _reviews[proposalId];
        if (!r.opened) revert ReviewNotOpen();

        IGovernorMinimal.ProposalView memory p = IGovernorMinimal(governor).getProposal(proposalId);
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
    function openEmergencyReview(uint256, bytes32) external {
        revert();
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
    function openReview(uint256 proposalId) external {
        if (paused) revert ProtocolPaused();
        Review storage r = _reviews[proposalId];
        if (r.opened) return; // idempotent

        uint256 ve = IGovernorMinimal(governor).getProposal(proposalId).voteEnd;
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

    function currentEpoch() external view returns (uint256) {
        return (block.timestamp - epochGenesis) / EPOCH_DURATION;
    }

    function pendingEpochReward(address, uint256) external view returns (uint256) {
        return 0; // Task 20
    }
}
