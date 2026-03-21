// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISyndicateGovernor} from "./interfaces/ISyndicateGovernor.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title GovernorParameters
 * @notice Abstract contract managing governance parameter setters, validation,
 *         and timelock-based parameter changes. Extracted from SyndicateGovernor
 *         to reduce contract size and improve separation of concerns.
 *
 *   - All parameter setters queue changes with a delay
 *   - Owner must call finalizeParameterChange() after the delay elapses
 *   - Owner can cancel pending changes at any time
 *   - Parameters are validated at both queue and finalize time
 */
abstract contract GovernorParameters is ISyndicateGovernor, OwnableUpgradeable {
    // ── Safety bounds (hardcoded) ──

    uint256 public constant MIN_VOTING_PERIOD = 1 hours;
    uint256 public constant MAX_VOTING_PERIOD = 30 days;
    uint256 public constant MIN_EXECUTION_WINDOW = 1 hours;
    uint256 public constant MAX_EXECUTION_WINDOW = 7 days;
    uint256 public constant MIN_VETO_THRESHOLD_BPS = 1000; // 10%
    uint256 public constant MAX_VETO_THRESHOLD_BPS = 10000; // 100%
    uint256 public constant MAX_PERFORMANCE_FEE_CAP = 5000; // 50%
    uint256 public constant ABSOLUTE_MIN_STRATEGY_DURATION = 1 hours;
    uint256 public constant ABSOLUTE_MAX_STRATEGY_DURATION = 30 days;
    uint256 public constant MIN_COOLDOWN_PERIOD = 1 hours;
    uint256 public constant MAX_COOLDOWN_PERIOD = 30 days;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10% cap on protocol fee

    // ── Collaborative proposal constants ──

    uint256 public constant MIN_SPLIT_BPS = 100; // 1%
    uint256 public constant MIN_COLLABORATION_WINDOW = 1 hours;
    uint256 public constant MAX_COLLABORATION_WINDOW = 7 days;
    uint256 public constant ABSOLUTE_MAX_CO_PROPOSERS = 10;

    // ── Timelock bounds ──

    uint256 public constant MIN_PARAM_CHANGE_DELAY = 6 hours;
    uint256 public constant MAX_PARAM_CHANGE_DELAY = 7 days;

    // ── Parameter keys ──

    bytes32 public constant PARAM_VOTING_PERIOD = keccak256("votingPeriod");
    bytes32 public constant PARAM_EXECUTION_WINDOW = keccak256("executionWindow");
    bytes32 public constant PARAM_VETO_THRESHOLD_BPS = keccak256("vetoThresholdBps");
    bytes32 public constant PARAM_MAX_PERF_FEE = keccak256("maxPerformanceFeeBps");
    bytes32 public constant PARAM_MIN_STRATEGY_DURATION = keccak256("minStrategyDuration");
    bytes32 public constant PARAM_MAX_STRATEGY_DURATION = keccak256("maxStrategyDuration");
    bytes32 public constant PARAM_COOLDOWN = keccak256("cooldownPeriod");
    bytes32 public constant PARAM_COLLAB_WINDOW = keccak256("collaborationWindow");
    bytes32 public constant PARAM_MAX_CO_PROPOSERS = keccak256("maxCoProposers");
    bytes32 public constant PARAM_PROTOCOL_FEE_BPS = keccak256("protocolFeeBps");

    // ── Virtual accessors (implemented by SyndicateGovernor) ──

    function _getParams() internal view virtual returns (GovernorParams storage);
    function _getParameterChangeDelay() internal view virtual returns (uint256);
    function _getPendingChanges() internal view virtual returns (mapping(bytes32 => PendingChange) storage);
    function _getProtocolFeeRecipient() internal view virtual returns (address);

    // ── Parameter setters (queue-based) ──

    /// @inheritdoc ISyndicateGovernor
    function setVotingPeriod(uint256 newVotingPeriod) external onlyOwner {
        _validateVotingPeriod(newVotingPeriod);
        _queueChange(PARAM_VOTING_PERIOD, newVotingPeriod);
    }

    /// @inheritdoc ISyndicateGovernor
    function setExecutionWindow(uint256 newExecutionWindow) external onlyOwner {
        _validateExecutionWindow(newExecutionWindow);
        _queueChange(PARAM_EXECUTION_WINDOW, newExecutionWindow);
    }

    /// @inheritdoc ISyndicateGovernor
    function setVetoThresholdBps(uint256 newVetoThresholdBps) external onlyOwner {
        _validateVetoThresholdBps(newVetoThresholdBps);
        _queueChange(PARAM_VETO_THRESHOLD_BPS, newVetoThresholdBps);
    }

    /// @inheritdoc ISyndicateGovernor
    function setMaxPerformanceFeeBps(uint256 newMaxPerformanceFeeBps) external onlyOwner {
        _validateMaxPerformanceFeeBps(newMaxPerformanceFeeBps);
        _queueChange(PARAM_MAX_PERF_FEE, newMaxPerformanceFeeBps);
    }

    /// @inheritdoc ISyndicateGovernor
    function setMinStrategyDuration(uint256 newMinStrategyDuration) external onlyOwner {
        GovernorParams storage params = _getParams();
        if (
            newMinStrategyDuration < ABSOLUTE_MIN_STRATEGY_DURATION
                || newMinStrategyDuration > params.maxStrategyDuration
        ) {
            revert InvalidStrategyDurationBounds();
        }
        _queueChange(PARAM_MIN_STRATEGY_DURATION, newMinStrategyDuration);
    }

    /// @inheritdoc ISyndicateGovernor
    function setMaxStrategyDuration(uint256 newMaxStrategyDuration) external onlyOwner {
        GovernorParams storage params = _getParams();
        if (
            newMaxStrategyDuration > ABSOLUTE_MAX_STRATEGY_DURATION
                || newMaxStrategyDuration < params.minStrategyDuration
        ) {
            revert InvalidStrategyDurationBounds();
        }
        _queueChange(PARAM_MAX_STRATEGY_DURATION, newMaxStrategyDuration);
    }

    /// @inheritdoc ISyndicateGovernor
    function setCooldownPeriod(uint256 newCooldownPeriod) external onlyOwner {
        _validateCooldownPeriod(newCooldownPeriod);
        _queueChange(PARAM_COOLDOWN, newCooldownPeriod);
    }

    /// @inheritdoc ISyndicateGovernor
    function setCollaborationWindow(uint256 newCollaborationWindow) external onlyOwner {
        if (newCollaborationWindow < MIN_COLLABORATION_WINDOW || newCollaborationWindow > MAX_COLLABORATION_WINDOW) {
            revert InvalidCollaborationWindow();
        }
        _queueChange(PARAM_COLLAB_WINDOW, newCollaborationWindow);
    }

    /// @inheritdoc ISyndicateGovernor
    function setMaxCoProposers(uint256 newMaxCoProposers) external onlyOwner {
        if (newMaxCoProposers == 0 || newMaxCoProposers > ABSOLUTE_MAX_CO_PROPOSERS) {
            revert InvalidMaxCoProposers();
        }
        _queueChange(PARAM_MAX_CO_PROPOSERS, newMaxCoProposers);
    }

    /// @inheritdoc ISyndicateGovernor
    function setProtocolFeeBps(uint256 newProtocolFeeBps) external onlyOwner {
        if (newProtocolFeeBps > MAX_PROTOCOL_FEE_BPS) revert InvalidProtocolFeeBps();
        if (newProtocolFeeBps > 0 && _getProtocolFeeRecipient() == address(0)) revert InvalidProtocolFeeRecipient();
        _queueChange(PARAM_PROTOCOL_FEE_BPS, newProtocolFeeBps);
    }

    // ── Timelock functions ──

    /// @inheritdoc ISyndicateGovernor
    function finalizeParameterChange(bytes32 paramKey) external onlyOwner {
        mapping(bytes32 => PendingChange) storage pending = _getPendingChanges();
        PendingChange storage change = pending[paramKey];
        if (!change.exists) revert NoChangePending();
        if (block.timestamp < change.effectiveAt) revert ChangeNotReady();

        uint256 newValue = change.newValue;

        // Re-validate at finalize time (other params may have changed since queue)
        _validateForFinalize(paramKey, newValue);

        // Apply the change
        _applyChange(paramKey, newValue);

        delete pending[paramKey];
    }

    /// @inheritdoc ISyndicateGovernor
    function cancelParameterChange(bytes32 paramKey) external onlyOwner {
        mapping(bytes32 => PendingChange) storage pending = _getPendingChanges();
        if (!pending[paramKey].exists) revert NoChangePending();
        delete pending[paramKey];
        emit ParameterChangeCancelled(paramKey);
    }

    /// @inheritdoc ISyndicateGovernor
    function getPendingChange(bytes32 paramKey) external view returns (PendingChange memory) {
        return _getPendingChanges()[paramKey];
    }

    /// @inheritdoc ISyndicateGovernor
    function getGovernorParams() external view returns (GovernorParams memory) {
        return _getParams();
    }

    // ── Internal helpers ──

    function _queueChange(bytes32 paramKey, uint256 newValue) internal {
        mapping(bytes32 => PendingChange) storage pending = _getPendingChanges();
        if (pending[paramKey].exists) revert ChangeAlreadyPending();

        uint256 delay = _getParameterChangeDelay();
        uint256 effectiveAt = block.timestamp + delay;

        pending[paramKey] = PendingChange({newValue: newValue, effectiveAt: effectiveAt, exists: true});

        emit ParameterChangeQueued(paramKey, newValue, effectiveAt);
    }

    function _applyChange(bytes32 paramKey, uint256 newValue) internal {
        GovernorParams storage params = _getParams();

        if (paramKey == PARAM_VOTING_PERIOD) {
            uint256 old = params.votingPeriod;
            params.votingPeriod = newValue;
            emit ParameterChangeFinalized(paramKey, old, newValue);
            emit VotingPeriodUpdated(old, newValue);
        } else if (paramKey == PARAM_EXECUTION_WINDOW) {
            uint256 old = params.executionWindow;
            params.executionWindow = newValue;
            emit ParameterChangeFinalized(paramKey, old, newValue);
            emit ExecutionWindowUpdated(old, newValue);
        } else if (paramKey == PARAM_VETO_THRESHOLD_BPS) {
            uint256 old = params.vetoThresholdBps;
            params.vetoThresholdBps = newValue;
            emit ParameterChangeFinalized(paramKey, old, newValue);
            emit VetoThresholdBpsUpdated(old, newValue);
        } else if (paramKey == PARAM_MAX_PERF_FEE) {
            uint256 old = params.maxPerformanceFeeBps;
            params.maxPerformanceFeeBps = newValue;
            emit ParameterChangeFinalized(paramKey, old, newValue);
            emit MaxPerformanceFeeBpsUpdated(old, newValue);
        } else if (paramKey == PARAM_MIN_STRATEGY_DURATION) {
            uint256 old = params.minStrategyDuration;
            params.minStrategyDuration = newValue;
            emit ParameterChangeFinalized(paramKey, old, newValue);
            emit MinStrategyDurationUpdated(old, newValue);
        } else if (paramKey == PARAM_MAX_STRATEGY_DURATION) {
            uint256 old = params.maxStrategyDuration;
            params.maxStrategyDuration = newValue;
            emit ParameterChangeFinalized(paramKey, old, newValue);
            emit MaxStrategyDurationUpdated(old, newValue);
        } else if (paramKey == PARAM_COOLDOWN) {
            uint256 old = params.cooldownPeriod;
            params.cooldownPeriod = newValue;
            emit ParameterChangeFinalized(paramKey, old, newValue);
            emit CooldownPeriodUpdated(old, newValue);
        } else if (paramKey == PARAM_COLLAB_WINDOW) {
            uint256 old = params.collaborationWindow;
            params.collaborationWindow = newValue;
            emit ParameterChangeFinalized(paramKey, old, newValue);
            emit CollaborationWindowUpdated(old, newValue);
        } else if (paramKey == PARAM_MAX_CO_PROPOSERS) {
            uint256 old = params.maxCoProposers;
            params.maxCoProposers = newValue;
            emit ParameterChangeFinalized(paramKey, old, newValue);
            emit MaxCoProposersUpdated(old, newValue);
        } else if (paramKey == PARAM_PROTOCOL_FEE_BPS) {
            uint256 old = _applyProtocolFeeBpsChange(newValue);
            emit ParameterChangeFinalized(paramKey, old, newValue);
        } else {
            revert InvalidParameterKey();
        }
    }

    /// @dev Re-validate at finalize time for params with cross-dependencies
    function _validateForFinalize(bytes32 paramKey, uint256 newValue) internal view {
        if (paramKey == PARAM_VOTING_PERIOD) {
            _validateVotingPeriod(newValue);
        } else if (paramKey == PARAM_EXECUTION_WINDOW) {
            _validateExecutionWindow(newValue);
        } else if (paramKey == PARAM_VETO_THRESHOLD_BPS) {
            _validateVetoThresholdBps(newValue);
        } else if (paramKey == PARAM_MAX_PERF_FEE) {
            _validateMaxPerformanceFeeBps(newValue);
        } else if (paramKey == PARAM_COOLDOWN) {
            _validateCooldownPeriod(newValue);
        } else if (paramKey == PARAM_MIN_STRATEGY_DURATION) {
            GovernorParams storage params = _getParams();
            if (newValue < ABSOLUTE_MIN_STRATEGY_DURATION || newValue > params.maxStrategyDuration) {
                revert InvalidStrategyDurationBounds();
            }
        } else if (paramKey == PARAM_MAX_STRATEGY_DURATION) {
            GovernorParams storage params = _getParams();
            if (newValue > ABSOLUTE_MAX_STRATEGY_DURATION || newValue < params.minStrategyDuration) {
                revert InvalidStrategyDurationBounds();
            }
        } else if (paramKey == PARAM_COLLAB_WINDOW) {
            if (newValue < MIN_COLLABORATION_WINDOW || newValue > MAX_COLLABORATION_WINDOW) {
                revert InvalidCollaborationWindow();
            }
        } else if (paramKey == PARAM_MAX_CO_PROPOSERS) {
            if (newValue == 0 || newValue > ABSOLUTE_MAX_CO_PROPOSERS) {
                revert InvalidMaxCoProposers();
            }
        } else if (paramKey == PARAM_PROTOCOL_FEE_BPS) {
            if (newValue > MAX_PROTOCOL_FEE_BPS) revert InvalidProtocolFeeBps();
            if (newValue > 0 && _getProtocolFeeRecipient() == address(0)) revert InvalidProtocolFeeRecipient();
        }
    }

    /// @dev Apply protocol fee change — implemented by SyndicateGovernor
    function _applyProtocolFeeBpsChange(uint256 newValue) internal virtual returns (uint256 old);

    // ── Validation helpers ──

    function _validateVotingPeriod(uint256 value) internal pure {
        if (value < MIN_VOTING_PERIOD || value > MAX_VOTING_PERIOD) revert InvalidVotingPeriod();
    }

    function _validateExecutionWindow(uint256 value) internal pure {
        if (value < MIN_EXECUTION_WINDOW || value > MAX_EXECUTION_WINDOW) revert InvalidExecutionWindow();
    }

    function _validateVetoThresholdBps(uint256 value) internal pure {
        if (value < MIN_VETO_THRESHOLD_BPS || value > MAX_VETO_THRESHOLD_BPS) revert InvalidVetoThresholdBps();
    }

    function _validateMaxPerformanceFeeBps(uint256 value) internal pure {
        if (value > MAX_PERFORMANCE_FEE_CAP) revert InvalidMaxPerformanceFeeBps();
    }

    function _validateCooldownPeriod(uint256 value) internal pure {
        if (value < MIN_COOLDOWN_PERIOD || value > MAX_COOLDOWN_PERIOD) revert InvalidCooldownPeriod();
    }
}
