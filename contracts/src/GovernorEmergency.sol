// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISyndicateGovernor} from "./interfaces/ISyndicateGovernor.sol";
import {ISyndicateVault} from "./interfaces/ISyndicateVault.sol";
import {IGuardianRegistry} from "./interfaces/IGuardianRegistry.sol";
import {BatchExecutorLib} from "./BatchExecutorLib.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title GovernorEmergency
/// @notice Abstract — emergency settlement paths extracted for bytecode headroom.
///         Inherited by SyndicateGovernor alongside GovernorParameters.
///
///         Implements the Task 24 guardian review lifecycle:
///           - `unstick`: vault owner rescues a proposal stuck in Executed state by
///             running its pre-committed settlement calls (no guardian review — the
///             calls were already governance-approved).
///           - `emergencySettleWithCalls`: vault owner proposes owner-supplied
///             settlement calls. Requires active owner bond. Opens a guardian review.
///           - `cancelEmergencySettle`: vault owner withdraws their review before
///             finalization.
///           - `finalizeEmergencySettle`: once the review period has elapsed and the
///             block quorum was not reached, the owner runs the reviewed calls.
///
///         The legacy single-entrypoint `emergencySettle(uint256, Call[])` was
///         fully removed in PR #229 (from both the interface and this abstract)
///         as part of the guardian-review narrowing.
abstract contract GovernorEmergency is ISyndicateGovernor {
    // ── Virtual accessors (implemented by SyndicateGovernor) ──

    function _getProposal(uint256) internal view virtual returns (StrategyProposal storage);
    function _getSettlementCalls(uint256) internal view virtual returns (BatchExecutorLib.Call[] storage);
    function _getRegistry() internal view virtual returns (IGuardianRegistry);
    function _emergencyReentrancyEnter() internal virtual;
    function _emergencyReentrancyLeave() internal virtual;

    // ── New virtual accessors (Task 24 — implemented by SyndicateGovernor) ──

    function _storeEmergencyCalls(uint256 pid, BatchExecutorLib.Call[] calldata calls) internal virtual;
    function _clearEmergencyCalls(uint256 pid) internal virtual;
    function _getEmergencyCallsHash(uint256 pid) internal view virtual returns (bytes32);
    function _finishSettlementHook(uint256 pid, StrategyProposal storage p)
        internal
        virtual
        returns (int256 pnl, uint256 totalFee);

    // ── Reentrancy modifier (shares status var with SyndicateGovernor) ──

    modifier emergencyNonReentrant() {
        _emergencyReentrancyEnter();
        _;
        _emergencyReentrancyLeave();
    }

    // ── Emergency settle lifecycle ──
    // NOTE (Task 25 / PR #229): the legacy `emergencySettle(uint256, Call[])`
    // entrypoint was removed from both the interface and this abstract along
    // with the rest of the guardian-review narrowing. Use `unstick` (runs the
    // pre-committed settlement calls) or `emergencySettleWithCalls` (guardian
    // gate) / `finalizeEmergencySettle` (after review).

    /// @notice Rescues a proposal stuck in Executed state past its duration by
    ///         running the governance-approved pre-committed settlement calls.
    /// @dev Does NOT require active owner stake — the calls were already voted on.
    ///      Settlement fees are distributed exactly as in the happy-path settle.
    function unstick(uint256 proposalId) external emergencyNonReentrant {
        StrategyProposal storage p = _getProposal(proposalId);
        if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
        if (p.state != ProposalState.Executed) revert ProposalNotExecuted();
        if (block.timestamp < p.executedAt + p.strategyDuration) revert StrategyDurationNotElapsed();
        // unstick does NOT require active owner stake — pre-committed calls were governance-approved.
        ISyndicateVault(p.vault).executeGovernorBatch(_getSettlementCalls(proposalId));
        _finishSettlementHook(proposalId, p);
    }

    /// @notice Vault owner opens an emergency review on a stuck proposal with
    ///         owner-supplied unwind calls. Requires bonded owner stake.
    /// @dev Emits `EmergencySettleProposed`. Guardian block votes run via the
    ///      registry during `reviewPeriod`; finalize via `finalizeEmergencySettle`.
    function emergencySettleWithCalls(uint256 proposalId, BatchExecutorLib.Call[] calldata calls)
        external
        emergencyNonReentrant
    {
        StrategyProposal storage p = _getProposal(proposalId);
        if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
        if (p.state != ProposalState.Executed) revert ProposalNotExecuted();
        if (block.timestamp < p.executedAt + p.strategyDuration) revert StrategyDurationNotElapsed();

        IGuardianRegistry reg = _getRegistry();
        if (reg.ownerStake(p.vault) < reg.requiredOwnerBond(p.vault)) revert OwnerBondInsufficient();

        bytes32 h = keccak256(abi.encode(calls));
        _storeEmergencyCalls(proposalId, calls);
        reg.openEmergencyReview(proposalId, h);
        emit EmergencySettleProposed(proposalId, msg.sender, h, uint64(block.timestamp + reg.reviewPeriod()));
    }

    /// @notice Vault owner withdraws their open emergency review before resolution.
    /// @dev Clears the stored calls hash and call array so a fresh review can be
    ///      opened later, and calls into the registry to fully invalidate the
    ///      in-progress review (zeroes `blockStakeWeight`, bumps the round nonce,
    ///      marks it resolved/not-blocked). Without the registry call a keeper
    ///      could still drive `resolveEmergencyReview` past `reviewEnd` and
    ///      `_slashOwner` on stale block votes. Reverts with `EmergencyNotProposed`
    ///      if no emergency settle was opened — prevents spurious
    ///      `EmergencyReviewCancelled` events on empty review structs.
    function cancelEmergencySettle(uint256 proposalId) external emergencyNonReentrant {
        StrategyProposal storage p = _getProposal(proposalId);
        if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
        if (_getEmergencyCallsHash(proposalId) == bytes32(0)) revert EmergencyNotProposed();
        _getRegistry().cancelEmergencyReview(proposalId);
        _clearEmergencyCalls(proposalId);
        emit EmergencySettleCancelled(proposalId, msg.sender);
    }

    /// @notice Resolves a reviewed emergency settle and executes the approved calls.
    /// @dev The caller must supply the same calls whose hash was pre-committed at
    ///      review open time. Reverts with `EmergencySettleBlocked` if guardians
    ///      reached the block quorum.
    function finalizeEmergencySettle(uint256 proposalId, BatchExecutorLib.Call[] calldata calls)
        external
        emergencyNonReentrant
    {
        StrategyProposal storage p = _getProposal(proposalId);
        if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
        if (keccak256(abi.encode(calls)) != _getEmergencyCallsHash(proposalId)) revert EmergencySettleMismatch();

        IGuardianRegistry reg = _getRegistry();
        bool blocked = reg.resolveEmergencyReview(proposalId);
        if (blocked) revert EmergencySettleBlocked();

        ISyndicateVault(p.vault).executeGovernorBatch(calls);
        (int256 pnl,) = _finishSettlementHook(proposalId, p);
        _clearEmergencyCalls(proposalId);
        emit EmergencySettleFinalized(proposalId, pnl);
    }

    /// @dev Per-abstract upgrade-hygiene storage gap. No storage variables
    ///      exist on `GovernorEmergency` today (all state is read via virtual
    ///      accessors from `SyndicateGovernor`), but reserving slots here
    ///      parallels `GovernorParameters.__paramsGap` so future additions to
    ///      this abstract can't collide with the concrete governor's layout.
    uint256[10] private __emergencyGap;
}
