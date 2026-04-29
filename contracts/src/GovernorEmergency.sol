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
///         V2: All emergency state (call hash, call array, review lifecycle) is
///         owned by GuardianRegistry. Governor entrypoints are thin wrappers that
///         delegate to the registry and execute calls on the vault.
///
///         - `unstick`: vault owner rescues a proposal stuck in Executed state by
///           running its pre-committed settlement calls (no guardian review).
///         - `emergencySettleWithCalls`: vault owner proposes owner-supplied
///           settlement calls. Opens a guardian review on the registry.
///         - `cancelEmergencySettle`: vault owner withdraws their review.
///         - `finalizeEmergencySettle`: once the review period has elapsed and the
///           block quorum was not reached, the owner executes the reviewed calls.
abstract contract GovernorEmergency is ISyndicateGovernor {
    // ── Virtual accessors (implemented by SyndicateGovernor) ──

    function _getProposal(uint256) internal view virtual returns (StrategyProposal storage);
    function _getSettlementCalls(uint256) internal view virtual returns (BatchExecutorLib.Call[] storage);
    function _getRegistry() internal view virtual returns (IGuardianRegistry);
    function _emergencyReentrancyEnter() internal virtual;
    function _emergencyReentrancyLeave() internal virtual;
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

    /// @notice Rescues a proposal stuck in Executed state past its duration by
    ///         running the governance-approved pre-committed settlement calls.
    /// @dev Does NOT require active owner stake — the calls were already voted on.
    function unstick(uint256 proposalId) external emergencyNonReentrant {
        StrategyProposal storage p = _getProposal(proposalId);
        if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
        if (p.state != ProposalState.Executed) revert ProposalNotExecuted();
        if (block.timestamp < p.executedAt + p.strategyDuration) revert StrategyDurationNotElapsed();
        ISyndicateVault(p.vault).executeGovernorBatch(_getSettlementCalls(proposalId));
        _finishSettlementHook(proposalId, p);
    }

    /// @notice Vault owner opens an emergency review on a stuck proposal with
    ///         owner-supplied unwind calls. Requires bonded owner stake.
    ///         All call storage is delegated to the registry.
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
        reg.openEmergency(proposalId, h, calls);
        emit EmergencySettleProposed(proposalId, msg.sender, h, uint64(block.timestamp + reg.reviewPeriod()));
    }

    /// @notice Vault owner withdraws their open emergency review before resolution.
    function cancelEmergencySettle(uint256 proposalId) external emergencyNonReentrant {
        StrategyProposal storage p = _getProposal(proposalId);
        if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
        if (p.state != ProposalState.Executed) revert ProposalNotExecuted();
        IGuardianRegistry reg = _getRegistry();
        if (!reg.isEmergencyOpen(proposalId)) revert EmergencyNotProposed();
        reg.cancelEmergency(proposalId);
        emit EmergencySettleCancelled(proposalId, msg.sender);
    }

    /// @notice Resolves a reviewed emergency settle and executes the approved calls.
    ///         Registry returns the stored calls; governor executes them on the vault.
    function finalizeEmergencySettle(uint256 proposalId) external emergencyNonReentrant {
        StrategyProposal storage p = _getProposal(proposalId);
        if (msg.sender != OwnableUpgradeable(p.vault).owner()) revert NotVaultOwner();
        if (p.state != ProposalState.Executed) revert ProposalNotExecuted();

        IGuardianRegistry reg = _getRegistry();
        (bool blocked, BatchExecutorLib.Call[] memory calls) = reg.finalizeEmergency(proposalId);
        if (blocked) revert EmergencySettleBlocked();

        ISyndicateVault(p.vault).executeGovernorBatch(calls);
        (int256 pnl,) = _finishSettlementHook(proposalId, p);
        emit EmergencySettleFinalized(proposalId, pnl);
    }

    /// @dev Per-abstract upgrade-hygiene storage gap.
    uint256[10] private __emergencyGap;
}
