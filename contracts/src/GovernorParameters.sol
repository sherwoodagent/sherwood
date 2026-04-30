// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISyndicateGovernor} from "./interfaces/ISyndicateGovernor.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 * @title GovernorParameters
 * @notice Abstract contract managing governance parameter setters and bounds
 *         validation. Extracted from SyndicateGovernor to keep separation of
 *         concerns and relieve bytecode pressure.
 *
 *         Setters are **owner-instant** (no on-chain timelock). The owner is
 *         expected to be a multisig with its own delay/approval workflow
 *         (e.g., Gnosis Safe + Zodiac Delay module). Enforcing a timelock
 *         on-chain in addition to the multisig's is redundant — the multisig
 *         is the governance unit, and a compromised multisig already
 *         dominates whatever on-chain delay exists.
 *
 *         All setters validate bounds at call time, apply immediately, and
 *         emit a uniform `ParameterChangeFinalized(paramKey, old, new)` event
 *         so indexers can subscribe to a single topic regardless of which
 *         parameter changed.
 */
abstract contract GovernorParameters is ISyndicateGovernor, OwnableUpgradeable {
    // ── Safety bounds (hardcoded) ──

    uint256 public constant MIN_VOTING_PERIOD = 1 hours;
    uint256 public constant MAX_VOTING_PERIOD = 30 days;
    uint256 public constant MIN_EXECUTION_WINDOW = 1 hours;
    uint256 public constant MAX_EXECUTION_WINDOW = 7 days;
    uint256 public constant MIN_VETO_THRESHOLD_BPS = 1000; // 10%
    uint256 public constant MAX_VETO_THRESHOLD_BPS = 5000; // 50%
    uint256 public constant MAX_PERFORMANCE_FEE_CAP = 5000; // 50%
    uint256 public constant ABSOLUTE_MIN_STRATEGY_DURATION = 1 hours;
    uint256 public constant ABSOLUTE_MAX_STRATEGY_DURATION = 30 days;
    uint256 public constant MIN_COOLDOWN_PERIOD = 1 hours;
    uint256 public constant MAX_COOLDOWN_PERIOD = 30 days;
    /// @notice 100% in basis points. Centralized so SyndicateGovernor and
    ///         GuardianRegistry both reference one constant.
    /// @dev `internal` to avoid emitting an auto-getter (would add ~39 bytes
    ///      to SyndicateGovernor; this constant is for internal arithmetic only).
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MAX_PROTOCOL_FEE_BPS = 1000; // 10%
    uint256 public constant MAX_GUARDIAN_FEE_BPS = 500; // 5%

    // ── Collaborative proposal constants ──

    uint256 public constant MIN_SPLIT_BPS = 100; // 1%
    uint256 public constant MIN_COLLABORATION_WINDOW = 1 hours;
    uint256 public constant MAX_COLLABORATION_WINDOW = 7 days;
    uint256 public constant ABSOLUTE_MAX_CO_PROPOSERS = 10;

    // ── Parameter keys (event topic discriminators) ──

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
    bytes32 public constant PARAM_PROTOCOL_FEE_RECIPIENT = keccak256("protocolFeeRecipient");
    bytes32 public constant PARAM_FACTORY = keccak256("factory");
    bytes32 public constant PARAM_GUARDIAN_FEE_BPS = keccak256("guardianFeeBps");

    // ── Storage (ToB P2-1: moved from `SyndicateGovernor` concrete) ──

    /// @notice Packed governance parameters (voting/execution windows, veto,
    ///         fee caps, strategy duration bounds, collaboration window).
    GovernorParams internal _params;

    /// @notice Protocol fee in bps (taken from profit before agent/mgmt fees).
    uint256 internal _protocolFeeBps;

    /// @notice Recipient of protocol fees.
    address internal _protocolFeeRecipient;

    /// @notice Guardian fee in bps (routed to the bound `_guardianRegistry`).
    uint256 internal _guardianFeeBps;

    /// @notice Authorized factory that can register vaults.
    address public factory;

    /// @dev Reserved storage slots at the `GovernorParameters` layer so future
    ///      param additions here don't shift `SyndicateGovernor`'s layout.
    uint256[10] private __paramsGap;

    // ── Parameter setters (owner-instant) ──

    /// @inheritdoc ISyndicateGovernor
    function setVotingPeriod(uint256 newValue) external onlyOwner {
        _validateVotingPeriod(newValue);
        uint256 old = _params.votingPeriod;
        _params.votingPeriod = newValue;
        emit ParameterChangeFinalized(PARAM_VOTING_PERIOD, old, newValue);
    }

    /// @inheritdoc ISyndicateGovernor
    function setExecutionWindow(uint256 newValue) external onlyOwner {
        _validateExecutionWindow(newValue);
        uint256 old = _params.executionWindow;
        _params.executionWindow = newValue;
        emit ParameterChangeFinalized(PARAM_EXECUTION_WINDOW, old, newValue);
    }

    /// @inheritdoc ISyndicateGovernor
    function setVetoThresholdBps(uint256 newValue) external onlyOwner {
        _validateVetoThresholdBps(newValue);
        uint256 old = _params.vetoThresholdBps;
        _params.vetoThresholdBps = newValue;
        emit ParameterChangeFinalized(PARAM_VETO_THRESHOLD_BPS, old, newValue);
    }

    /// @inheritdoc ISyndicateGovernor
    function setMaxPerformanceFeeBps(uint256 newValue) external onlyOwner {
        _validateMaxPerformanceFeeBps(newValue);
        uint256 old = _params.maxPerformanceFeeBps;
        _params.maxPerformanceFeeBps = newValue;
        emit ParameterChangeFinalized(PARAM_MAX_PERF_FEE, old, newValue);
    }

    /// @inheritdoc ISyndicateGovernor
    function setMinStrategyDuration(uint256 newValue) external onlyOwner {
        if (newValue < ABSOLUTE_MIN_STRATEGY_DURATION || newValue > _params.maxStrategyDuration) {
            revert InvalidStrategyDurationBounds();
        }
        uint256 old = _params.minStrategyDuration;
        _params.minStrategyDuration = newValue;
        emit ParameterChangeFinalized(PARAM_MIN_STRATEGY_DURATION, old, newValue);
    }

    /// @inheritdoc ISyndicateGovernor
    function setMaxStrategyDuration(uint256 newValue) external onlyOwner {
        if (newValue > ABSOLUTE_MAX_STRATEGY_DURATION || newValue < _params.minStrategyDuration) {
            revert InvalidStrategyDurationBounds();
        }
        uint256 old = _params.maxStrategyDuration;
        _params.maxStrategyDuration = newValue;
        emit ParameterChangeFinalized(PARAM_MAX_STRATEGY_DURATION, old, newValue);
    }

    /// @inheritdoc ISyndicateGovernor
    function setCooldownPeriod(uint256 newValue) external onlyOwner {
        _validateCooldownPeriod(newValue);
        uint256 old = _params.cooldownPeriod;
        _params.cooldownPeriod = newValue;
        emit ParameterChangeFinalized(PARAM_COOLDOWN, old, newValue);
    }

    /// @inheritdoc ISyndicateGovernor
    function setCollaborationWindow(uint256 newValue) external onlyOwner {
        if (newValue < MIN_COLLABORATION_WINDOW || newValue > MAX_COLLABORATION_WINDOW) {
            revert InvalidCollaborationWindow();
        }
        uint256 old = _params.collaborationWindow;
        _params.collaborationWindow = newValue;
        emit ParameterChangeFinalized(PARAM_COLLAB_WINDOW, old, newValue);
    }

    /// @inheritdoc ISyndicateGovernor
    function setMaxCoProposers(uint256 newValue) external onlyOwner {
        if (newValue == 0 || newValue > ABSOLUTE_MAX_CO_PROPOSERS) revert InvalidMaxCoProposers();
        uint256 old = _params.maxCoProposers;
        _params.maxCoProposers = newValue;
        emit ParameterChangeFinalized(PARAM_MAX_CO_PROPOSERS, old, newValue);
    }

    /// @inheritdoc ISyndicateGovernor
    function setProtocolFeeBps(uint256 newValue) external onlyOwner {
        if (newValue > MAX_PROTOCOL_FEE_BPS) revert InvalidProtocolFeeBps();
        if (newValue > 0 && _protocolFeeRecipient == address(0)) revert InvalidProtocolFeeRecipient();
        uint256 old = _protocolFeeBps;
        _protocolFeeBps = newValue;
        emit ParameterChangeFinalized(PARAM_PROTOCOL_FEE_BPS, old, newValue);
    }

    /// @inheritdoc ISyndicateGovernor
    function setProtocolFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert InvalidProtocolFeeRecipient();
        uint256 old = uint256(uint160(_protocolFeeRecipient));
        _protocolFeeRecipient = newRecipient;
        emit ParameterChangeFinalized(PARAM_PROTOCOL_FEE_RECIPIENT, old, uint256(uint160(newRecipient)));
    }

    /// @inheritdoc ISyndicateGovernor
    function setFactory(address newFactory) external onlyOwner {
        if (newFactory == address(0)) revert ZeroAddress();
        uint256 old = uint256(uint160(factory));
        factory = newFactory;
        emit ParameterChangeFinalized(PARAM_FACTORY, old, uint256(uint160(newFactory)));
    }

    /// @inheritdoc ISyndicateGovernor
    /// @dev ToB P1-1: no recipient check — fees always route to the bound
    ///      `_guardianRegistry`, which is non-zero by initialize.
    function setGuardianFeeBps(uint256 newValue) external onlyOwner {
        if (newValue > MAX_GUARDIAN_FEE_BPS) revert InvalidGuardianFeeBps();
        uint256 old = _guardianFeeBps;
        _guardianFeeBps = newValue;
        emit ParameterChangeFinalized(PARAM_GUARDIAN_FEE_BPS, old, newValue);
    }

    /// @inheritdoc ISyndicateGovernor
    function getGovernorParams() external view returns (GovernorParams memory) {
        return _params;
    }

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
