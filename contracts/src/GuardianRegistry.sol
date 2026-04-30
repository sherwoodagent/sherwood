// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IGuardianRegistry} from "./interfaces/IGuardianRegistry.sol";
import {BatchExecutorLib} from "./BatchExecutorLib.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";

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
    /// @notice Count of proposals for a vault in any non-terminal state
    ///         (Pending / GuardianReview / Approved / Executed). Consumed
    ///         by the rage-quit gate in `requestUnstakeOwner`. The OR check
    ///         against `getActiveProposal` below is belt-and-braces — any
    ///         real open proposal must trip at least one of the two signals
    ///         (PR #229 Fix 2).
    function openProposalCount(address vault) external view returns (uint256);
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
    /// @notice 100% in basis points.
    /// @dev `internal` to avoid emitting an auto-getter (the registry is at the
    ///      28-byte EIP-170 ceiling — every byte counts).
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 public constant EPOCH_DURATION = 7 days;
    uint256 public constant MIN_COHORT_STAKE_AT_OPEN = 50_000 * 1e18;
    uint256 public constant MAX_APPROVERS_PER_PROPOSAL = 100;
    /// @notice ToB I-2: upper bound on blockers per proposal. Caps the O(n)
    ///         `BlockerAttributed` emit loop in `_emitBlockerAttribution` so
    ///         `resolveReview` cannot be gas-DoS'd. Blockers beyond the cap
    ///         revert at vote time; quorum math remains correct because
    ///         `r.blockStakeWeight` only accumulates for successful pushes.
    uint256 public constant MAX_BLOCKERS_PER_PROPOSAL = 100;
    uint256 public constant SWEEP_DELAY = 12 weeks;
    uint256 public constant LATE_VOTE_LOCKOUT_BPS = 1000;
    uint256 public constant MAX_REFUND_PER_EPOCH_BPS = 2000;
    uint256 public constant DEADMAN_UNPAUSE_DELAY = 7 days;
    uint256 public constant MAX_CALLS_PER_PROPOSAL = 64;
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    // ── Parameter keys (used as event topic discriminators) ──
    bytes32 public constant PARAM_MIN_GUARDIAN_STAKE = keccak256("minGuardianStake");
    bytes32 public constant PARAM_MIN_OWNER_STAKE = keccak256("minOwnerStake");
    bytes32 public constant PARAM_COOLDOWN = keccak256("coolDownPeriod");
    bytes32 public constant PARAM_REVIEW_PERIOD = keccak256("reviewPeriod");
    bytes32 public constant PARAM_BLOCK_QUORUM_BPS = keccak256("blockQuorumBps");

    // ── Storage — see spec §3.1 for layout ──
    struct Guardian {
        uint128 stakedAmount;
        uint64 stakedAt;
        uint64 unstakeRequestedAt;
        uint256 agentId;
    }

    mapping(address => Guardian) internal _guardians;
    uint256 public totalGuardianStake;

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
        uint64 openedAt; // V1.5: timestamp for checkpoint lookup of vote weight
        uint128 totalDelegatedAtOpen; // V1.5: delegation half of the quorum denom
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
        uint8 nonce; // bumped on open/cancel so prior block votes go stale
        uint64 openedAt; // V1.5: timestamp for checkpoint lookup of vote weight
        uint128 totalDelegatedAtOpen; // V1.5: delegation half of the quorum denom
    }

    mapping(uint256 => EmergencyReview) internal _emergencyReviews;
    // keyed by (proposalId, nonce, guardian) so cancelling + re-opening starts a
    // fresh round; prior-round votes are invisible to the new nonce.
    mapping(uint256 => mapping(uint8 => mapping(address => bool))) internal _emergencyBlockVotes;

    /// @dev Emergency call array — stored by governor via `openEmergency`,
    ///      returned on `finalizeEmergency`, cleared on cancel/finalize.
    ///      Moved from SyndicateGovernor to consolidate emergency state.
    mapping(uint256 => BatchExecutorLib.Call[]) internal _emergencyCalls;

    // Epoch accounting (V1.5: WOOD epoch block-rewards moved to Merkl; only
    // epochGenesis remains on-chain as the epoch-index anchor used by
    // setCommission's raise-epoch calculation and off-chain Merkl bot.)
    uint256 public epochGenesis;

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
    uint256 public coolDownPeriod;
    uint256 public reviewPeriod;
    uint256 public blockQuorumBps;

    // Privileged addresses
    address public governor;
    address public factory;
    IERC20 public wood;

    // ── V1.5 vote-weight checkpoints (Task 1.2) ──
    using Checkpoints for Checkpoints.Trace224;

    /// @dev Per-guardian own-stake history, keyed by timestamp. Pushed on every
    ///      state change that affects votable weight: stakeAsGuardian,
    ///      requestUnstakeGuardian (push 0), cancelUnstakeGuardian, slash.
    ///      `getPastStake(g, t)` returns the votable amount at `t`.
    mapping(address => Checkpoints.Trace224) internal _stakeCheckpoints;

    /// @dev Global total-active-stake history. Mirrors `totalGuardianStake`
    ///      but indexed by timestamp for historical quorum-denominator lookups.
    Checkpoints.Trace224 internal _totalStakeCheckpoint;

    // ── V1.5 delegation (Task 2.1) ──
    /// @dev Per-(delegator, delegate) locked balance. WOOD moves from the
    ///      delegator's wallet into the registry on `delegateStake`.
    mapping(address delegator => mapping(address delegate => uint256)) internal _delegations;

    /// @dev Per-(delegator, delegate) historical balance. At vote / reward
    ///      attribution we look up `_delegationCheckpoints[delegator][delegate]
    ///      .upperLookupRecent(reviewOpenedAt)` to split the delegate's
    ///      voting pool among their delegators.
    mapping(address delegator => mapping(address delegate => Checkpoints.Trace224)) internal _delegationCheckpoints;

    /// @dev Per-(delegator, delegate) unstake-request timestamp; 0 = no request.
    mapping(address delegator => mapping(address delegate => uint64)) internal _unstakeDelegationRequestedAt;

    /// @dev Per-delegate inbound delegation sum (current).
    mapping(address delegate => uint256) internal _delegatedInbound;

    /// @dev Per-delegate inbound delegation history for `getPastDelegated`.
    mapping(address delegate => Checkpoints.Trace224) internal _delegatedInboundCheckpoints;

    /// @dev Global sum of all delegations (for quorum denominator at review open).
    uint256 public totalDelegatedStake;

    /// @dev Global delegation total history for `getPastTotalDelegated`.
    Checkpoints.Trace224 internal _totalDelegatedCheckpoint;

    // ── V1.5 Phase 3: DPoS commission (Task 3.1) ──

    /// @notice Max commission a delegate can charge their delegators (50%).
    uint256 public constant MAX_COMMISSION_BPS = 5000;

    /// @notice Max bps increase per epoch (5%). Prevents delegates from
    ///         instant-ramping commission to rug their delegators' share of
    ///         already-earned rewards. Decreases are unbounded.
    uint256 public constant MAX_COMMISSION_INCREASE_PER_EPOCH = 500;

    /// @dev Current commission rate per delegate.
    mapping(address => uint256) internal _commissionBps;

    /// @dev Epoch in which the delegate last raised (or first-set) their
    ///      commission. Used to detect transition into a new raise-epoch so
    ///      `_commissionEpochBaseline` can be re-anchored.
    mapping(address => uint256) internal _lastCommissionRaiseEpoch;

    /// @dev Anchor for the per-epoch cumulative raise cap. Seeded on:
    ///      - first-ever set: baseline = newBps (rate is being announced)
    ///      - first raise of a new epoch: baseline = rate at epochStart - 1
    ///        (last pre-epoch checkpoint)
    ///      Subsequent raises within the same epoch keep the baseline fixed,
    ///      so chained raises cannot compound past
    ///      `baseline + MAX_COMMISSION_INCREASE_PER_EPOCH` (INV-V1.5-6).
    mapping(address => uint256) internal _commissionEpochBaseline;

    /// @dev Per-delegate commission history keyed by timestamp. Consumed by
    ///      `claimProposalReward` which looks up the rate at `settledAt` —
    ///      closes the retroactive-raise vector (INV-V1.5-11). Also consumed
    ///      by `setCommission` itself to derive the per-epoch raise baseline.
    mapping(address => Checkpoints.Trace224) internal _commissionCheckpoints;

    // ── V1.5 Phase 3: per-proposal guardian-fee pool (Tasks 3.6-3.9) ──

    struct ProposalRewardPool {
        address asset;
        uint128 amount;
        uint64 settledAt;
    }

    /// @dev Funded by governor in `_distributeFees` when guardianFeeBps > 0.
    mapping(uint256 => ProposalRewardPool) internal _proposalGuardianPool;

    /// @dev Claim flags for approvers (set in `claimProposalReward`).
    mapping(uint256 => mapping(address => bool)) internal _approverClaimed;

    /// @dev Remainder (approver's net-of-commission pool) stored after the
    ///      approver claims, to be pulled by their delegators pro-rata.
    mapping(address => mapping(uint256 => uint256)) internal _delegatorProposalPool;
    mapping(address => mapping(uint256 => mapping(address => bool))) internal _delegatorProposalClaimed;

    /// @dev W-1 escrow for guardian-fee reward transfers that fail (e.g. USDC
    ///      blacklist). Keyed by `keccak256(proposalId, recipient, asset)` to
    ///      prevent cross-proposal drain (same pattern as governor's
    ///      `_unclaimedFees`). Public to expose an auto-generated
    ///      `unclaimedApproverFees(bytes32 key) returns (uint256)` view —
    ///      cheaper than a wrapped 3-arg external view.
    mapping(bytes32 => uint256) public unclaimedApproverFees;

    /// @dev Reserved storage for future upgrades.
    ///      Slot accounting since V1: -9 (Phase 1 + Phase 2),
    ///      -4 (commission), -5 (guardian-fee pool + claim flags + escrow),
    ///      +2 (removed parameter-change timelock),
    ///      +3 (P1-3/4/5: drop activeGuardianCount + _emergencyVoteStake + minter),
    ///      -1 (V2 _emergencyCalls)
    ///      = -14 total.
    uint256[37] private __gap;

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
        coolDownPeriod = coolDownPeriod_;
        reviewPeriod = reviewPeriod_;
        blockQuorumBps = blockQuorumBps_;
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
        }
        totalGuardianStake += amount;

        // V1.5: checkpoint votable stake for historical quorum lookups.
        _stakeCheckpoints[msg.sender].push(uint32(block.timestamp), uint224(newTotal));
        _totalStakeCheckpoint.push(uint32(block.timestamp), uint224(totalGuardianStake));

        emit GuardianStaked(msg.sender, amount, agentId);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Immediately revokes voting power by zeroing the guardian's contribution to
    ///      `totalGuardianStake`. WOOD stays in the registry until
    ///      `claimUnstakeGuardian` after `coolDownPeriod`.
    function requestUnstakeGuardian() external {
        Guardian storage g = _guardians[msg.sender];
        if (g.stakedAmount == 0) revert NoActiveStake();
        if (g.unstakeRequestedAt != 0) revert UnstakeAlreadyRequested();

        g.unstakeRequestedAt = uint64(block.timestamp);
        totalGuardianStake -= g.stakedAmount;

        // V1.5: unstake-requested stake is not votable. Push 0 so getPastStake
        // reflects the on-cooldown state accurately.
        _stakeCheckpoints[msg.sender].push(uint32(block.timestamp), 0);
        _totalStakeCheckpoint.push(uint32(block.timestamp), uint224(totalGuardianStake));

        emit GuardianUnstakeRequested(msg.sender, block.timestamp);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Reverses `requestUnstakeGuardian`: restores voting power.
    function cancelUnstakeGuardian() external {
        Guardian storage g = _guardians[msg.sender];
        if (g.unstakeRequestedAt == 0) revert UnstakeNotRequested();
        // Bug B fix: if the guardian was slashed between `requestUnstakeGuardian`
        // and now, `stakedAmount == 0` but `unstakeRequestedAt` still points at
        // the original request. "Cancelling" here would resurrect a ghost
        // guardian with no stake. Nothing to restore → revert.
        if (g.stakedAmount == 0) revert NoActiveStake();

        g.unstakeRequestedAt = 0;
        totalGuardianStake += g.stakedAmount;

        // V1.5: stake is votable again.
        _stakeCheckpoints[msg.sender].push(uint32(block.timestamp), uint224(g.stakedAmount));
        _totalStakeCheckpoint.push(uint32(block.timestamp), uint224(totalGuardianStake));

        emit GuardianUnstakeCancelled(msg.sender);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev After `coolDownPeriod` from `unstakeRequestedAt`, releases WOOD and
    ///      deregisters the guardian entirely (struct deleted — agentId can differ on
    ///      a subsequent re-stake).
    // ──────────────────────────────────────────────────────────────
    // V1.5 — Stake-pool delegation (Phase 2)
    // ──────────────────────────────────────────────────────────────

    /// @inheritdoc IGuardianRegistry
    /// @dev Permissive delegation — any address can be a delegate. To be
    ///      active-guardian-eligible, the delegate still needs their OWN
    ///      stake >= minGuardianStake (delegation adds to vote weight but
    ///      does not bypass activation). Delegating to self is disallowed to
    ///      keep own-stake and delegated pools strictly disjoint.
    ///
    ///      Custody moves into the registry; balance tracked per-(delegator,
    ///      delegate) pair with a Trace224 checkpoint for historical
    ///      attribution. If the delegator had a pending unstake request for
    ///      this delegate, re-delegating implicitly cancels it.
    function delegateStake(address delegate, uint256 amount) external nonReentrant {
        if (delegate == msg.sender) revert CannotSelfDelegate();
        if (delegate == address(0)) revert InvalidDelegate();
        if (amount == 0) revert AmountZero();
        // I-5: delegating to a guardian that has 0 active stake (never staked,
        // fully slashed, or mid-unstake) traps the delegator's WOOD behind the
        // 7-day cooldown pointing at a vote-inert address. Reject early so the
        // UX surface + accounting both reflect reality.
        if (!_isActiveGuardian(delegate)) revert InactiveDelegate();

        // Re-delegation implicitly cancels any in-flight unstake request.
        _unstakeDelegationRequestedAt[msg.sender][delegate] = 0;

        wood.safeTransferFrom(msg.sender, address(this), amount);

        uint256 newBalance = _delegations[msg.sender][delegate] + amount;
        _delegations[msg.sender][delegate] = newBalance;
        _delegatedInbound[delegate] += amount;
        totalDelegatedStake += amount;

        _delegationCheckpoints[msg.sender][delegate].push(uint32(block.timestamp), uint224(newBalance));
        _delegatedInboundCheckpoints[delegate].push(uint32(block.timestamp), uint224(_delegatedInbound[delegate]));
        _totalDelegatedCheckpoint.push(uint32(block.timestamp), uint224(totalDelegatedStake));

        emit DelegationIncreased(msg.sender, delegate, amount);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Starts the 7-day unstake-delegation cooldown. The delegation slot
    ///      stays non-zero in `_delegations` (delegate's vote weight at any
    ///      already-opened review that referenced the delegator's weight at
    ///      `r.openedAt` is frozen via the Trace224 checkpoint, so requesting
    ///      unstake now does not retroactively change anything).
    function requestUnstakeDelegation(address delegate) external {
        if (_delegations[msg.sender][delegate] == 0) revert NoActiveDelegation();
        if (_unstakeDelegationRequestedAt[msg.sender][delegate] != 0) revert UnstakeAlreadyRequested();
        _unstakeDelegationRequestedAt[msg.sender][delegate] = uint64(block.timestamp);
        emit DelegationUnstakeRequested(msg.sender, delegate, block.timestamp);
    }

    /// @inheritdoc IGuardianRegistry
    function cancelUnstakeDelegation(address delegate) external {
        if (_unstakeDelegationRequestedAt[msg.sender][delegate] == 0) revert NoUnstakeRequest();
        _unstakeDelegationRequestedAt[msg.sender][delegate] = 0;
        emit DelegationUnstakeCancelled(msg.sender, delegate);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev After `coolDownPeriod`, zeros the delegation slot, decrements the
    ///      delegate's inbound totals and global total, pushes zero checkpoints
    ///      for the delegator + inbound histories, and refunds WOOD.
    /// @dev nonReentrant dropped — CEI: delegation zeroed + checkpoints
    ///      pushed before transfer.
    function claimUnstakeDelegation(address delegate) external {
        uint64 requestedAt = _unstakeDelegationRequestedAt[msg.sender][delegate];
        if (requestedAt == 0) revert NoUnstakeRequest();
        if (block.timestamp < uint256(requestedAt) + coolDownPeriod) revert UnstakeCooldownActive();

        uint256 amount = _delegations[msg.sender][delegate];
        _delegations[msg.sender][delegate] = 0;
        _unstakeDelegationRequestedAt[msg.sender][delegate] = 0;
        _delegatedInbound[delegate] -= amount;
        totalDelegatedStake -= amount;

        _delegationCheckpoints[msg.sender][delegate].push(uint32(block.timestamp), 0);
        _delegatedInboundCheckpoints[delegate].push(uint32(block.timestamp), uint224(_delegatedInbound[delegate]));
        _totalDelegatedCheckpoint.push(uint32(block.timestamp), uint224(totalDelegatedStake));

        wood.safeTransfer(msg.sender, amount);
        emit DelegationUnstakeClaimed(msg.sender, delegate, amount);
    }

    // ──────────────────────────────────────────────────────────────
    // V1.5 Phase 3 — DPoS commission configuration (Task 3.1)
    // ──────────────────────────────────────────────────────────────

    /// @inheritdoc IGuardianRegistry
    /// @dev Sets the caller's commission rate (0 – MAX_COMMISSION_BPS) that
    ///      applies to their delegators' share of future guardian-fee and WOOD
    ///      epoch rewards. Raises capped to `MAX_COMMISSION_INCREASE_PER_EPOCH`
    ///      bps above the rate that held at the start of the current epoch —
    ///      *cumulative*, so chaining multiple raises within the same epoch
    ///      can't compound past the cap. Decreases are unbounded. Pushes a
    ///      checkpoint so historical claims resolve the rate at their
    ///      `settledAt`.
    function setCommission(uint256 newBps) external {
        if (newBps > MAX_COMMISSION_BPS) revert CommissionExceedsMax();

        uint256 old = _commissionBps[msg.sender];
        if (newBps == old) return;

        if (newBps > old) {
            uint256 curEpoch = currentEpoch();
            (bool hasHistory,,) = _commissionCheckpoints[msg.sender].latestCheckpoint();
            // ToB review C-2: first-set is exempt from the raise cap ONLY
            // if the delegate has no delegators yet. Previously first-set was
            // unconditionally uncapped, allowing a delegate to accept
            // delegations at implied 0% commission and then JIT-rug to 50% in
            // the same block as `settledAt` — defeating rug-protection. By
            // gating the exemption on `_delegatedInbound == 0`, legitimate
            // delegates can still announce any opening rate before attracting
            // delegators, but any post-delegation raise is rate-limited.
            if (!hasHistory && _delegatedInbound[msg.sender] == 0) {
                // Pure announcement: no delegators at risk, no cap.
                _commissionEpochBaseline[msg.sender] = newBps;
                _lastCommissionRaiseEpoch[msg.sender] = curEpoch;
            } else {
                if (_lastCommissionRaiseEpoch[msg.sender] != curEpoch) {
                    // New raise-epoch: re-anchor baseline to previous-epoch
                    // final state. Lookup at epochStart - 1 excludes any
                    // checkpoint pushed this epoch. First-set-with-delegators
                    // (no prior checkpoint) yields baseline = 0.
                    uint256 epochStart = epochGenesis + curEpoch * EPOCH_DURATION;
                    uint256 probe = epochStart - 1;
                    _commissionEpochBaseline[msg.sender] =
                        _commissionCheckpoints[msg.sender].upperLookupRecent(uint32(probe));
                    _lastCommissionRaiseEpoch[msg.sender] = curEpoch;
                }
                uint256 baseline = _commissionEpochBaseline[msg.sender];
                if (newBps > baseline + MAX_COMMISSION_INCREASE_PER_EPOCH) {
                    revert CommissionRaiseExceedsLimit();
                }
            }
        }

        _commissionBps[msg.sender] = newBps;
        _commissionCheckpoints[msg.sender].push(uint32(block.timestamp), uint224(newBps));

        emit CommissionSet(msg.sender, old, newBps);
    }

    /// @inheritdoc IGuardianRegistry
    function commissionOf(address delegate) external view returns (uint256) {
        return _commissionBps[delegate];
    }

    /// @inheritdoc IGuardianRegistry
    function commissionAt(address delegate, uint256 timestamp) external view returns (uint256) {
        return _commissionCheckpoints[delegate].upperLookupRecent(uint32(timestamp));
    }

    // ──────────────────────────────────────────────────────────────
    // V1.5 Phase 3 — Guardian-fee pool funding (Task 3.6)
    // ──────────────────────────────────────────────────────────────

    /// @inheritdoc IGuardianRegistry
    /// @dev Called by governor from `_distributeFees` after transferring the
    ///      guardian-fee slice to this contract. Stamps the pool so approvers
    ///      + delegators can pull via `claimProposalReward` /
    ///      `claimDelegatorProposalReward` (Tasks 3.7 / 3.8).
    function fundProposalGuardianPool(uint256 proposalId, address asset, uint256 amount) external {
        if (msg.sender != governor) revert NotGovernor();
        if (amount == 0) return;
        // Defensive: governor's `Executed → Settled` state machine makes this
        // unreachable today, but guard against a future state-machine change
        // silently overwriting an already-funded pool (would permanently lock
        // the first amount and break approver/delegator claims).
        if (_proposalGuardianPool[proposalId].settledAt != 0) revert PoolAlreadyFunded();
        _proposalGuardianPool[proposalId] =
            ProposalRewardPool({asset: asset, amount: uint128(amount), settledAt: uint64(block.timestamp)});
        emit ProposalGuardianPoolFunded(proposalId, asset, amount);
    }

    // View: `proposalGuardianPool` removed to reclaim bytecode. Consumers can
    // subscribe to the governor's `GuardianFeeAccrued(proposalId, asset,
    // recipient, amount, settledAt)` event (same data) or static-call
    // `claimProposalReward` and parse the `ApproverRewardClaimed` event for
    // the amount that would transfer.

    // ──────────────────────────────────────────────────────────────
    // V1.5 Phase 3 — Guardian-fee claim paths (Tasks 3.7 / 3.8 / 3.9)
    // ──────────────────────────────────────────────────────────────

    /// @inheritdoc IGuardianRegistry
    /// @dev Approve-side-only reward. The approver's gross share is split by
    ///      source: the portion attributable to their OWN stake is paid
    ///      directly to them in full; the portion attributable to their
    ///      delegators is split by DPoS commission rate (commission paid to
    ///      approver, remainder stored for delegators to claim). A solo
    ///      approver with no delegators receives their full gross share
    ///      regardless of commission rate (closes the "solo-approver-loses-
    ///      remainder" bug from PR #242 review, finding C-1).
    ///      Commission rate is looked up at `settledAt` via
    ///      `_commissionCheckpoints` (INV-V1.5-11).
    ///      CEI is respected: `_approverClaimed[...] = true` is set before the
    ///      external transfer, so reentry hits `AlreadyClaimed`. No
    ///      `nonReentrant` needed.
    function claimProposalReward(uint256 proposalId) external whenNotPaused {
        ProposalRewardPool memory pool = _proposalGuardianPool[proposalId];
        if (pool.amount == 0) revert NoPoolFunded();
        if (_approverClaimed[proposalId][msg.sender]) revert AlreadyClaimed();

        // Approve-side only. `_voteStake > 0` is guaranteed whenever
        // `_votes == Approve` (voteOnProposal reverts on zero-weight voters).
        if (_votes[proposalId][msg.sender] != GuardianVoteType.Approve) revert NotApprover();

        // Compute the four payout numbers in a scope block so all the
        // intermediate locals (w, r, ownW, grossFromOwn, grossFromDelegated,
        // rate) get freed before the `_safeRewardTransfer` call site.
        // Required for `forge coverage` (no via_ir) — see #257.
        uint256 gross;
        uint256 commission;
        uint256 remainder;
        uint256 approverPayout;
        {
            uint256 w = _voteStake[proposalId][msg.sender];
            Review storage r = _reviews[proposalId];
            // approveStakeWeight >= w by construction (w is one of the weights summed into it).
            gross = (uint256(pool.amount) * w) / uint256(r.approveStakeWeight);

            // Split the approver's gross share between own-stake portion (fully
            // to approver) and delegated-stake portion (commission split).
            // ownW is read at `r.openedAt` — the SAME timestamp used to freeze
            // `w` in voteOnProposal — so `w >= ownW` holds by construction (w =
            // own@openedAt + delegated@openedAt). No clamp needed. Reading at
            // `settledAt` instead would strand funds when an approver requests
            // unstake mid-review (PR #242 re-review, finding I-A).
            uint256 ownW = _stakeCheckpoints[msg.sender].upperLookupRecent(uint32(r.openedAt));
            uint256 grossFromOwn = (gross * ownW) / w;
            uint256 grossFromDelegated = gross - grossFromOwn;

            // Commission RATE stays at settledAt (INV-V1.5-11) — only the
            // vote-weight lookup moves to openedAt.
            uint256 rate = _commissionCheckpoints[msg.sender].upperLookupRecent(uint32(pool.settledAt));
            commission = (grossFromDelegated * rate) / BPS_DENOMINATOR;
            approverPayout = grossFromOwn + commission;
            remainder = grossFromDelegated - commission;
        }

        // CEI: flag + pool-seed before external transfer. Always-write (even
        // zero remainder) is cheaper in bytecode than branching; solo
        // approvers pay ~2.1k gas for a zero-write — acceptable vs the
        // EIP-170 pressure on the registry.
        _approverClaimed[proposalId][msg.sender] = true;
        _delegatorProposalPool[msg.sender][proposalId] = remainder;

        if (approverPayout > 0) {
            _safeRewardTransfer(pool.asset, msg.sender, approverPayout, proposalId);
        }
        emit ApproverRewardClaimed(proposalId, msg.sender, gross, commission, remainder);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Pulls the delegator's pro-rata share of the delegate's remainder
    ///      pool. Requires the delegate to have already called
    ///      `claimProposalReward` (otherwise the pool is zero). Attribution
    ///      timestamp is `openedAt` — same as the approver's vote-weight
    ///      snapshot — so delegator denominator and `grossFromDelegated`
    ///      numerator align (PR #242 re-review, finding I-B).
    /// @dev Not `whenNotPaused` — bytecode reclaim. The delegator pool was
    ///      already seeded by the approver's claim (which IS paused-gated),
    ///      so value is already earmarked for delegators; pausing the pull
    ///      doesn't protect anything. `claimUnstakeGuardian` applies the
    ///      same reasoning.
    function claimDelegatorProposalReward(address delegate, uint256 proposalId) external {
        if (_delegatorProposalClaimed[delegate][proposalId][msg.sender]) revert AlreadyClaimed();
        uint256 pool = _delegatorProposalPool[delegate][proposalId];
        if (pool == 0) revert DelegatePoolEmpty();

        ProposalRewardPool memory p = _proposalGuardianPool[proposalId];
        uint32 openedAt = uint32(_reviews[proposalId].openedAt);

        uint256 my = _delegationCheckpoints[msg.sender][delegate].upperLookupRecent(openedAt);
        uint256 totalDelegated = _delegatedInboundCheckpoints[delegate].upperLookupRecent(openedAt);
        // `totalDelegated == 0` would underflow division. `my == 0` would just
        // compute share = 0; claim flag still flips so no double-claim rot.
        if (totalDelegated == 0) revert NoDelegationAtSettle();

        uint256 share = (pool * my) / totalDelegated;

        // CEI: flag before transfer.
        _delegatorProposalClaimed[delegate][proposalId][msg.sender] = true;

        if (share > 0) {
            _safeRewardTransfer(p.asset, msg.sender, share, proposalId);
        }
        emit DelegatorProposalRewardClaimed(msg.sender, delegate, proposalId, share);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev W-1 retry path. After the transfer-failure condition is lifted
    ///      (e.g., USDC blacklist removed), anyone can flush the escrow to the
    ///      recipient. Keyed by (proposalId, recipient, asset) so a malicious
    ///      flush cannot redirect to an unrelated recipient — CEI pattern from
    ///      PR #229 review cross-vault-drain fix.
    ///
    ///      M-6 note on pause semantics: `flushBurn` (WOOD slashing path) is
    ///      `nonReentrant whenNotPaused` because it interacts with slashing
    ///      accounting that might need to freeze during incident review.
    ///      `flushUnclaimedApproverFee` is neither: the escrow is already
    ///      earmarked for a specific recipient (value is committed outside the
    ///      settlement flow) and reentry can't corrupt state (CEI: slot
    ///      cleared before transfer). Honoring a pause here would strand
    ///      already-earned rewards behind an outage for no security benefit.
    function flushUnclaimedApproverFee(uint256 proposalId, address recipient, address asset) external {
        bytes32 key = keccak256(abi.encode(proposalId, recipient, asset));
        uint256 amount = unclaimedApproverFees[key];
        if (amount == 0) revert NoEscrowedAmount();

        unclaimedApproverFees[key] = 0;
        IERC20(asset).safeTransfer(recipient, amount);
        // Indexers observe the successful retry via the ERC20 Transfer event
        // paired with `unclaimedApproverFees` zeroing out — no dedicated flush
        // event (reclaimed bytecode).
    }

    // V1.5: pending-reward views removed to reclaim bytecode. UIs can
    // simulate via `eth_call(claimProposalReward)` / `eth_call(claimDelegator*)`
    // which returns success/revert + consumed gas, or compute off-chain from
    // `proposalGuardianPool` + `_voteStake` + `commissionAt` + checkpoint views.

    // `unclaimedApproverFee(pid, recipient, asset)` wrapper view removed to
    // reclaim bytecode. The public mapping `unclaimedApproverFees(bytes32)`
    // serves as the getter — callers compute the key via
    // `keccak256(abi.encode(proposalId, recipient, asset))` and query:
    //   cast call <registry> 'unclaimedApproverFees(bytes32)' <key>
    // or subscribe to `ApproverFeeEscrowed(pid, recipient, asset, amount)`
    // events.

    /// @dev Wrapped ERC20 transfer for guardian-fee claims. On failure (e.g.
    ///      USDC blacklist), records the amount in `unclaimedApproverFees`
    ///      keyed by `(proposalId, recipient, asset)` + emits
    ///      `ApproverFeeEscrowed`. Cross-proposal drain is impossible because
    ///      the key includes `proposalId` (regression guard from PR #229 review).
    function _safeRewardTransfer(address asset, address recipient, uint256 amount, uint256 proposalId) private {
        bool ok;
        try IERC20(asset).transfer(recipient, amount) returns (bool r) {
            ok = r;
        } catch {}
        if (!ok) {
            unclaimedApproverFees[keccak256(abi.encode(proposalId, recipient, asset))] += amount;
            emit ApproverFeeEscrowed(proposalId, recipient, asset, amount);
        }
    }

    // ──────────────────────────────────────────────────────────────

    /// @dev nonReentrant dropped — CEI: struct deleted before transfer.
    function claimUnstakeGuardian() external {
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
    /// @dev First-vote path OR vote-change. Requires `openReview` to have been
    ///      called and `voteEnd <= now < reviewEnd`. Snapshots the caller's
    ///      own + delegated-inbound stake at `r.openedAt` into
    ///      `_voteStake[proposalId][caller]` and adds it to the chosen side's
    ///      tally. Approvers and Blockers are each capped at
    ///      `MAX_APPROVERS_PER_PROPOSAL` / `MAX_BLOCKERS_PER_PROPOSAL`
    ///      (ToB I-2 added the Blocker cap so `_emitBlockerAttribution` stays
    ///      O(1)). Vote-change is allowed until the final
    ///      `LATE_VOTE_LOCKOUT_BPS` of the review window; the preserved
    ///      `_voteStake` snapshot moves with the caller, and the new-side cap
    ///      is checked BEFORE mutating the old side so a revert leaves the
    ///      prior vote intact.
    ///
    ///      V1.5: vote weight is read from `_stakeCheckpoints[voter]` at
    ///      `r.openedAt`, so both numerator (each voter's contribution) and
    ///      denominator (`r.totalStakeAtOpen`) are measured at the same
    ///      instant. Closes the top-up-before-vote bias.
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
            // First vote — snapshot own + delegated weight AT `r.openedAt`.
            uint256 own = _stakeCheckpoints[msg.sender].upperLookupRecent(uint32(r.openedAt));
            if (own == 0) revert NotActiveGuardian(); // no active own stake at open time
            uint256 delegated = _delegatedInboundCheckpoints[msg.sender].upperLookupRecent(uint32(r.openedAt));
            uint128 weight = uint128(own + delegated);
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
            // `LATE_VOTE_LOCKOUT_BPS` of the review window is locked to
            // prevent last-minute flips that would make honest early Approvers
            // strictly worse off than abstainers. Derive the window from the
            // proposal's stamped `voteEnd`/`reviewEnd` — NOT the live
            // `reviewPeriod` — so that owner-multisig changes to
            // `reviewPeriod` after proposal creation cannot shift the lockout
            // start time.
            uint256 reviewWindow = uint256(p.reviewEnd) - uint256(p.voteEnd);
            uint256 lockoutStart = p.reviewEnd - (reviewWindow * LATE_VOTE_LOCKOUT_BPS) / BPS_DENOMINATOR;
            if (block.timestamp >= lockoutStart) revert VoteChangeLockedOut();

            uint128 weight = _voteStake[proposalId][msg.sender]; // preserved snapshot
            // LOAD-BEARING INVARIANT for weight accounting: the new-side cap
            // is checked inline BEFORE any `_remove*` / `_push*` call. The
            // subsequent `_push{Approver,Blocker}` MUST NOT gain a new failure
            // mode on top of the cap — if it does, the old-side decrement
            // will have already executed, silently corrupting stake tallies.
            // See the vote-change fragility finding on PR #229 review.
            if (existing == GuardianVoteType.Approve) {
                // Approve → Block (ToB I-2: blockers are now capped).
                if (_blockers[proposalId].length >= MAX_BLOCKERS_PER_PROPOSAL) revert NewSideFull();
                _removeApprover(proposalId, msg.sender);
                r.approveStakeWeight -= weight;
                _pushBlocker(proposalId, msg.sender); // cap pre-checked above — must succeed
                r.blockStakeWeight += weight;
            } else {
                // Block → Approve.
                if (_approvers[proposalId].length >= MAX_APPROVERS_PER_PROPOSAL) revert NewSideFull();
                _removeBlocker(proposalId, msg.sender);
                r.blockStakeWeight -= weight;
                _pushApprover(proposalId, msg.sender); // cap pre-checked above — must succeed
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
        // ToB I-2: cap parallels MAX_APPROVERS_PER_PROPOSAL so the
        // `BlockerAttributed` emit loop in `_emitBlockerAttribution` is
        // O(MAX_BLOCKERS_PER_PROPOSAL) — bounded gas at `resolveReview`.
        if (_blockers[proposalId].length >= MAX_BLOCKERS_PER_PROPOSAL) {
            emit BlockerCapReached(proposalId);
            revert NewSideFull();
        }
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
    /// @dev nonReentrant dropped — CEI: struct deleted before transfer.
    function cancelPreparedStake() external {
        PreparedOwnerStake storage p = _prepared[msg.sender];
        if (p.amount == 0 || p.bound) revert PreparedStakeNotFound();

        uint256 amount = p.amount;
        delete _prepared[msg.sender];

        wood.safeTransfer(msg.sender, amount);

        emit PreparedStakeCancelled(msg.sender, amount);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Vault owner signals intent to exit. Blocked while the vault has any
    ///      open proposal (Pending / GuardianReview / Approved / Executed) to
    ///      prevent rage-quit around malicious executions. Immediately stamps
    ///      `unstakeRequestedAt`; WOOD stays escrowed until `claimUnstakeOwner`.
    ///
    ///      PR #229 Fix 2: the legacy `getActiveProposal` check only covered
    ///      the Executed state; a malicious owner could propose a draining
    ///      strategy and rage-quit before execution. `openProposalCount` now
    ///      tracks every non-terminal state (Pending / GuardianReview /
    ///      Approved / Executed). The OR against `getActiveProposal` below
    ///      is belt-and-braces so that any stale-cache window still reverts.
    function requestUnstakeOwner(address vault) external {
        OwnerStake storage s = _ownerStakes[vault];
        if (s.owner != msg.sender || s.stakedAmount == 0) revert NoActiveStake();
        if (s.unstakeRequestedAt != 0) revert UnstakeAlreadyRequested();
        IGovernorMinimal gov = IGovernorMinimal(governor);
        if (gov.openProposalCount(vault) != 0 || gov.getActiveProposal(vault) != 0) {
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
    /// @dev nonReentrant dropped — CEI: struct deleted before transfer.
    function claimUnstakeOwner(address vault) external {
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
    /// @dev nonReentrant dropped — no external calls after state write.
    function bindOwnerStake(address owner_, address vault) external onlyFactory {
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
    ///      with ≥ `requiredOwnerBond(vault)`. Reverts with `PriorStakeNotCleared`
    ///      if the prior owner still has residual stake (they must first
    ///      complete `requestUnstakeOwner` → `claimUnstakeOwner`, or be
    ///      slashed, before the slot can be transferred).
    /// @dev nonReentrant dropped — no external calls after state write.
    function transferOwnerStakeSlot(address vault, address newOwner) external onlyFactory {
        OwnerStake storage existing = _ownerStakes[vault];
        address oldOwner = existing.owner;
        if (existing.stakedAmount != 0) revert PriorStakeNotCleared();

        PreparedOwnerStake storage p = _prepared[newOwner];
        if (p.amount == 0 || p.bound) revert PreparedStakeNotFound();
        if (p.amount < requiredOwnerBond(vault)) revert OwnerBondInsufficient();

        _ownerStakes[vault] = OwnerStake({stakedAmount: p.amount, unstakeRequestedAt: 0, owner: newOwner});
        p.bound = true;

        emit OwnerStakeSlotTransferred(vault, oldOwner, newOwner);
    }

    // ── Governor-only (emergency) ──
    /// @inheritdoc IGuardianRegistry
    /// @notice Governor opens an emergency review, storing the call array and
    ///         its pre-commitment hash. The registry is the single owner of all
    ///         emergency state — governor holds nothing.
    function openEmergency(uint256 proposalId, bytes32 callsHash, BatchExecutorLib.Call[] calldata calls)
        external
        onlyGovernor
    {
        if (calls.length > MAX_CALLS_PER_PROPOSAL) revert EmergencyTooManyCalls();
        if (keccak256(abi.encode(calls)) != callsHash) revert EmergencyHashMismatch();

        EmergencyReview storage er = _emergencyReviews[proposalId];
        if (er.reviewEnd > 0 && !er.resolved) revert EmergencyAlreadyOpen();
        uint64 newReviewEnd = uint64(block.timestamp + reviewPeriod);
        er.callsHash = callsHash;
        er.reviewEnd = newReviewEnd;
        er.totalStakeAtOpen = uint128(totalGuardianStake);
        er.totalDelegatedAtOpen = uint128(totalDelegatedStake);
        er.blockStakeWeight = 0;
        er.resolved = false;
        er.blocked = false;
        er.openedAt = uint64(block.timestamp - 1);
        unchecked {
            er.nonce++;
        }

        _storeEmergencyCalls(proposalId, calls);
        emit EmergencyReviewOpened(proposalId, callsHash, newReviewEnd);
    }

    /// @dev Stores emergency calls in storage, replacing any prior array.
    function _storeEmergencyCalls(uint256 proposalId, BatchExecutorLib.Call[] calldata calls) private {
        delete _emergencyCalls[proposalId];
        for (uint256 i; i < calls.length;) {
            _emergencyCalls[proposalId].push(calls[i]);
            unchecked {
                ++i;
            }
        }
    }

    /// @notice Governor cancels an open emergency review. Invalidates votes,
    ///         clears stored calls, marks resolved so stale votes can't slash.
    /// @dev Reverts after `reviewEnd` — once the review window elapsed the
    ///      owner must face resolution (permissionless `resolveEmergencyReview`
    ///      can commit the slash). Prevents cancel-after-block-quorum bypass.
    function cancelEmergency(uint256 proposalId) external onlyGovernor {
        EmergencyReview storage er = _emergencyReviews[proposalId];
        if (er.reviewEnd > 0 && block.timestamp >= er.reviewEnd) revert ReviewNotOpen();
        er.resolved = true;
        er.blocked = false;
        er.blockStakeWeight = 0;
        er.reviewEnd = 0;
        er.callsHash = bytes32(0);
        unchecked {
            er.nonce++;
        }
        delete _emergencyCalls[proposalId];
        emit EmergencyReviewCancelled(proposalId);
    }

    /// @notice Returns true if an emergency review is open (not yet resolved)
    ///         for the given proposal. Used by the governor's `_finishSettlement`
    ///         to skip unnecessary `cancelEmergency` calls.
    function isEmergencyOpen(uint256 proposalId) external view returns (bool) {
        EmergencyReview storage er = _emergencyReviews[proposalId];
        return er.reviewEnd > 0 && !er.resolved;
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
        uint128 delegatedAtOpen = uint128(totalDelegatedStake); // V1.5
        uint256 combinedAtOpen = uint256(totalAtOpen) + uint256(delegatedAtOpen);
        r.opened = true;
        r.totalStakeAtOpen = totalAtOpen;
        r.totalDelegatedAtOpen = delegatedAtOpen;
        // V1.5 + ToB review C-1: anchor at `block.timestamp - 1`. See
        // openEmergencyReview for rationale. Flash-delegation in the same
        // block as openReview would otherwise inflate vote weight.
        r.openedAt = uint64(block.timestamp - 1);
        if (combinedAtOpen < MIN_COHORT_STAKE_AT_OPEN) {
            r.cohortTooSmall = true;
            emit CohortTooSmallToReview(proposalId, uint128(combinedAtOpen));
        } else {
            emit ReviewOpened(proposalId, uint128(combinedAtOpen));
        }
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Permissionless. Idempotent — once resolved, returns the cached
    ///      `blocked` flag without re-slashing. Requires
    ///      `block.timestamp >= reviewEnd`. Short-circuits to `false` when
    ///      `!opened` (no activity) or `cohortTooSmall` (cold-start fallback).
    ///      Otherwise: `denom = totalStakeAtOpen + totalDelegatedAtOpen` (V1.5
    ///      includes delegated weight) and
    ///      `blocked = (blockStakeWeight * 10_000 >= blockQuorumBps * denom)`.
    ///      CEI: sets `resolved`/`blocked` flags BEFORE any token transfer.
    ///      When blocked, slashes all approvers' stake to BURN_ADDRESS and
    ///      credits blockers' weights to the current epoch's block-weight
    ///      tallies (spec §3.1, epoch attribution uses resolve-time
    ///      `block.timestamp`).
    /// @dev nonReentrant dropped — CEI respected: `resolved`/`blocked` flags
    ///      committed before the `_slashApprovers` transfer. Reentrant call
    ///      into `resolveReview` hits `if (r.resolved) return r.blocked` early.
    function resolveReview(uint256 proposalId) external whenNotPaused returns (bool) {
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

        // V1.5: denominator is own stake + delegated stake at review open.
        uint256 denom = uint256(r.totalStakeAtOpen) + uint256(r.totalDelegatedAtOpen);
        bool blocked_ = (uint256(r.blockStakeWeight) * 10_000 >= blockQuorumBps * denom);

        // CEI: commit state BEFORE any external transfer.
        r.resolved = true;
        r.blocked = blocked_;

        uint256 slashed;
        if (blocked_) {
            slashed = _slashApprovers(proposalId);
            _emitBlockerAttribution(proposalId);
        }

        emit ReviewResolved(proposalId, blocked_, slashed);
        return blocked_;
    }

    /// @dev Slash each approver by the snapshotted `_voteStake` weight (NOT their
    ///      live `stakedAmount`) so guardians who topped up after voting don't
    ///      lose the top-up. The snapshot is captured at vote time so
    ///      `stakedAmount >= snapshot` USUALLY holds — EXCEPT when the approver
    ///      has been partially slashed by a concurrent proposal that resolved
    ///      first, in which case `live < snapshot`. The clamp at the `amt =
    ///      snapshot <= live ? snapshot : live` line below is LOAD-BEARING for
    ///      that case — do not remove it as "unreachable." The clamp also
    ///      covers slashed/unstaked approvers (live == 0 → skipped earlier).
    ///      Accumulate total, decrement aggregate counters, then attempt one
    ///      `wood.transfer(BURN, total)`. If the transfer reverts or returns
    ///      false, the amount is queued in `_pendingBurn[address(this)]` for
    ///      retry via `flushBurn`.
    function _slashApprovers(uint256 proposalId) private returns (uint256 total) {
        address[] storage approvers = _approvers[proposalId];
        uint256 n = approvers.length;
        for (uint256 i = 0; i < n; i++) {
            address a = approvers[i];
            Guardian storage gs = _guardians[a];
            uint256 live = gs.stakedAmount;
            if (live == 0) continue;
            uint256 snapshot = uint256(_voteStake[proposalId][a]);
            // Clamp: snapshot should never exceed live stake, but if it does
            // (e.g. guardian partially slashed by a concurrent proposal that
            // resolved first), take only what's there.
            uint256 amt = snapshot <= live ? snapshot : live;
            if (amt == 0) continue;
            total += amt;
            // forge-lint: disable-next-line(unchecked-cast)
            gs.stakedAmount = uint128(live - amt);
            // If the approver was still active (hadn't requested unstake), the
            // aggregate counter includes their stake → remove the slashed
            // amount from totalGuardianStake. If they'd already requested
            // unstake, `totalGuardianStake` was already decremented at
            // request time.
            if (gs.unstakeRequestedAt == 0) {
                totalGuardianStake -= amt;
                // V1.5: checkpoint the post-slash votable stake. Only when the
                // approver was still active; if unstake was requested they were
                // already at 0-votable and the checkpoint push already happened
                // in requestUnstakeGuardian.
                _stakeCheckpoints[a].push(uint32(block.timestamp), uint224(gs.stakedAmount));
            } else if (gs.stakedAmount == 0) {
                // Defense in depth for Bug B: a fully-slashed guardian keeps no
                // stake — there's nothing for cancelUnstake to restore, so
                // clear the timestamp too.
                gs.unstakeRequestedAt = 0;
            }
        }

        if (total == 0) return 0;

        // V1.5: checkpoint the aggregate total-stake drop once after the loop.
        _totalStakeCheckpoint.push(uint32(block.timestamp), uint224(totalGuardianStake));

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

    /// @dev V1.5: emits `BlockerAttributed(proposalId, epochId, blocker, weight)`
    ///      for each blocker so Merkl's off-chain bot can build the epoch WOOD
    ///      campaign's Merkle roots. Replaces V1's on-chain
    ///      `epochGuardianBlockWeight` + `epochTotalBlockWeight` + `epochBudget`
    ///      accounting, which moved to Merkl.
    function _emitBlockerAttribution(uint256 proposalId) private {
        uint256 epochId = (block.timestamp - epochGenesis) / EPOCH_DURATION;
        address[] storage blockers = _blockers[proposalId];
        uint256 n = blockers.length;
        for (uint256 i = 0; i < n; i++) {
            address b = blockers[i];
            uint256 w = _voteStake[proposalId][b];
            if (w == 0) continue;
            emit BlockerAttributed(proposalId, epochId, b, w);
        }
    }

    /// @notice Governor finalizes an emergency review after the review window.
    ///         Returns (blocked, calls). If already resolved by the permissionless
    ///         `resolveEmergencyReview`, returns cached result + calls without
    ///         re-slashing.
    function finalizeEmergency(uint256 proposalId)
        external
        onlyGovernor
        whenNotPaused
        returns (bool, BatchExecutorLib.Call[] memory)
    {
        EmergencyReview storage er = _emergencyReviews[proposalId];
        if (er.reviewEnd == 0 || block.timestamp < er.reviewEnd) revert ReviewNotReadyForResolve();
        if (!er.resolved) _resolveEmergency(proposalId, er);
        BatchExecutorLib.Call[] memory result = _loadEmergencyCalls(proposalId);
        delete _emergencyCalls[proposalId];
        return (er.blocked, result);
    }

    /// @notice Permissionless keeper entrypoint — commits emergency review
    ///         resolution and slashes the vault owner if blocked. Does NOT
    ///         return or execute calls. The governor's `finalizeEmergencySettle`
    ///         must still be called to execute the calls (if not blocked).
    /// @dev Restores the V1 permissionless slash path so the bond deterrent
    ///      works even if the owner never calls `finalizeEmergencySettle`.
    function resolveEmergencyReview(uint256 proposalId) external whenNotPaused {
        EmergencyReview storage er = _emergencyReviews[proposalId];
        if (er.reviewEnd == 0 || block.timestamp < er.reviewEnd) revert ReviewNotReadyForResolve();
        if (er.resolved) return; // idempotent
        _resolveEmergency(proposalId, er);
    }

    /// @dev Shared resolution logic for `finalizeEmergency` and
    ///      `resolveEmergencyReview`. Commits `resolved`/`blocked` flags
    ///      and slashes the vault owner if blocked.
    function _resolveEmergency(uint256 proposalId, EmergencyReview storage er) private {
        uint256 denomE = uint256(er.totalStakeAtOpen) + uint256(er.totalDelegatedAtOpen);
        bool blocked_;
        if (denomE > 0) {
            blocked_ = (uint256(er.blockStakeWeight) * 10_000 >= blockQuorumBps * denomE);
        }
        er.resolved = true;
        er.blocked = blocked_;
        uint256 slashed;
        if (blocked_) slashed = _slashOwner(proposalId);
        emit EmergencyReviewResolved(proposalId, blocked_, slashed);
    }

    /// @dev Copies emergency calls from storage to memory.
    function _loadEmergencyCalls(uint256 pid) private view returns (BatchExecutorLib.Call[] memory r) {
        BatchExecutorLib.Call[] storage s = _emergencyCalls[pid];
        uint256 n = s.length;
        r = new BatchExecutorLib.Call[](n);
        for (uint256 i; i < n;) {
            r[i] = s[i];
            unchecked {
                ++i;
            }
        }
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Active-guardian-only. Block-only side (no Approve pool for
    ///      emergency reviews). One vote per guardian — double-votes revert.
    ///      Weight is the caller's current `guardianStake` at call time.
    /// @dev V1.5: weight is read from `_stakeCheckpoints[voter]` at
    ///      `er.openedAt`, matching the standard-review semantics. Numerator
    ///      and denominator both measured at the same instant.
    function voteBlockEmergencySettle(uint256 proposalId) external whenNotPaused {
        EmergencyReview storage er = _emergencyReviews[proposalId];
        if (er.reviewEnd == 0 || block.timestamp >= er.reviewEnd) revert ReviewNotOpen();
        if (!_isActiveGuardian(msg.sender)) revert NotActiveGuardian();
        uint8 nonce = er.nonce;
        if (_emergencyBlockVotes[proposalId][nonce][msg.sender]) revert AlreadyVoted();

        uint256 ownE = _stakeCheckpoints[msg.sender].upperLookupRecent(uint32(er.openedAt));
        if (ownE == 0) revert NotActiveGuardian(); // no own stake at review-open time
        uint256 delegatedE = _delegatedInboundCheckpoints[msg.sender].upperLookupRecent(uint32(er.openedAt));
        uint128 weight = uint128(ownE + delegatedE);
        _emergencyBlockVotes[proposalId][nonce][msg.sender] = true;
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
    /// @dev nonReentrant dropped — CEI: `_pendingBurn` zeroed before transfer.
    function flushBurn() external whenNotPaused {
        uint256 amt = _pendingBurn[address(this)];
        if (amt == 0) return;
        _pendingBurn[address(this)] = 0;
        wood.safeTransfer(BURN_ADDRESS, amt);
        emit BurnFlushed(amt);
    }

    // ── V1.5: WOOD epoch block-rewards moved to Merkl ──
    //
    // Removed V1 on-chain machinery: `fundEpoch`, `claimEpochReward`,
    // `sweepUnclaimed`, `pendingEpochReward`, + all per-epoch accounting
    // storage. Merkl campaign attribution is driven by the
    // `BlockerAttributed` event emitted in `_emitBlockerAttribution` during
    // `resolveReview`, plus `CommissionSet` + `DelegationIncreased` /
    // `DelegationUnstakeClaimed` events already emitted elsewhere. The
    // Merkl funding tx is a plain WOOD transfer from the owner multisig
    // to the Merkl distributor — indexers attribute it without any
    // registry-side event (ToB P1-5).

    // ── Slash appeal ──
    /// @inheritdoc IGuardianRegistry
    /// @dev Pulls WOOD from caller into `slashAppealReserve`. Owner-only —
    ///      this is an admin-capitalized safety net, not a permissionless
    ///      pool. Admin-only ops stay callable while paused.
    /// @dev nonReentrant dropped — owner-only, CEI: state updated before transfer.
    function fundSlashAppealReserve(uint256 amount) external onlyOwner {
        wood.safeTransferFrom(msg.sender, address(this), amount);
        slashAppealReserve += amount;
        emit SlashAppealReserveFunded(msg.sender, amount);
    }

    /// @inheritdoc IGuardianRegistry
    /// @dev Per-epoch refund cap is `MAX_REFUND_PER_EPOCH_BPS` (20%) of the
    ///      CURRENT reserve size. Cumulative refunds per epoch are tracked
    ///      in `refundedInEpoch[epochId]`; cap resets with each new epoch.
    ///      Owner-only; admin-only ops stay callable while paused.
    /// @dev nonReentrant dropped — owner-only, CEI: reserve decremented before transfer.
    function refundSlash(address recipient, uint256 amount) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();

        uint256 ep = currentEpoch();
        uint256 cap = (slashAppealReserve * MAX_REFUND_PER_EPOCH_BPS) / BPS_DENOMINATOR;
        if (refundedInEpoch[ep] + amount > cap) revert RefundCapExceeded();

        refundedInEpoch[ep] += amount;
        slashAppealReserve -= amount;

        wood.safeTransfer(recipient, amount);
        emit SlashAppealRefunded(recipient, amount, ep);
    }

    // ── Pause ──
    /// @inheritdoc IGuardianRegistry
    /// @dev Owner-only. Freezes review voting, proposal-reward claim, and
    ///      flushBurn. Stake/unstake paths and admin ops
    ///      (fundSlashAppealReserve, refundSlash, parameter setters) stay
    ///      callable so guardians can exit and the owner can capitalize the
    ///      reserve during an incident.
    function pause() external onlyOwner {
        if (paused) revert AlreadyPaused();
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

    // ── Parameter setters (owner-instant; registry owner is a multisig with
    //    external delay, so an on-chain timelock would double-count the delay) ──

    /// @inheritdoc IGuardianRegistry
    function setMinGuardianStake(uint256 v) external onlyOwner {
        if (v < 1e18) revert InvalidParameter();
        _setParam(PARAM_MIN_GUARDIAN_STAKE, minGuardianStake, v);
        minGuardianStake = v;
    }

    /// @inheritdoc IGuardianRegistry
    function setMinOwnerStake(uint256 v) external onlyOwner {
        if (v < 1_000 * 1e18) revert InvalidParameter();
        _setParam(PARAM_MIN_OWNER_STAKE, minOwnerStake, v);
        minOwnerStake = v;
    }

    /// @inheritdoc IGuardianRegistry
    function setCooldownPeriod(uint256 v) external onlyOwner {
        if (v < 1 days || v > 30 days) revert InvalidParameter();
        _setParam(PARAM_COOLDOWN, coolDownPeriod, v);
        coolDownPeriod = v;
    }

    /// @inheritdoc IGuardianRegistry
    function setReviewPeriod(uint256 v) external onlyOwner {
        if (v < 6 hours || v > 7 days) revert InvalidParameter();
        _setParam(PARAM_REVIEW_PERIOD, reviewPeriod, v);
        reviewPeriod = v;
    }

    /// @inheritdoc IGuardianRegistry
    function setBlockQuorumBps(uint256 v) external onlyOwner {
        if (v < 1_000 || v > 10_000) revert InvalidParameter();
        _setParam(PARAM_BLOCK_QUORUM_BPS, blockQuorumBps, v);
        blockQuorumBps = v;
    }

    function _setParam(bytes32 key, uint256 old, uint256 v) private {
        emit ParameterChangeFinalized(key, old, v);
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

    /// @notice Historical votable own-stake for `guardian` at `timestamp`.
    /// @dev    V1.5: used by `voteOnProposal` / `voteBlockEmergencySettle`
    ///         to read weight at `openedAt` instead of live stake — closes
    ///         the top-up-before-vote bias.
    // V2: getPastStake, getPastTotalStake, getPastDelegated, getPastTotalDelegated,
    // getPastDelegationTo, getPastVoteWeight all removed to reclaim bytecode.
    // Off-chain callers read checkpoints via eth_getStorageAt or events.

    function delegationOf(address delegator, address delegate) external view returns (uint256) {
        return _delegations[delegator][delegate];
    }

    function delegatedInbound(address delegate) external view returns (uint256) {
        return _delegatedInbound[delegate];
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

    /// @notice The minimum WOOD bond a vault owner must post.
    /// @dev Returns the global floor `minOwnerStake`. TVL-scaling was explored
    ///      and rejected: it mixes decimals (WOOD 18 vs. asset decimals) and
    ///      doesn't improve deterrence since `finalizeEmergencySettle` reverts
    ///      when a block quorum is reached (drain + slash are mutually exclusive).
    function requiredOwnerBond(address) public view returns (uint256) {
        return minOwnerStake;
    }

    function currentEpoch() public view returns (uint256) {
        return (block.timestamp - epochGenesis) / EPOCH_DURATION;
    }

    // pendingEpochReward removed in V1.5 — claimed via Merkl (merkl.xyz).
}
