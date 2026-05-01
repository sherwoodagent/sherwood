// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IStrategy} from "../../src/interfaces/IStrategy.sol";

/// @notice Minimal IStrategy stub for vault NAV tests. Lets a test set
///         `(value, valid)` returned by `positionValue()` and records
///         the last `onLiveDeposit` call so the vault's forwarding hook
///         can be asserted.
contract MockStrategyAdapter is IStrategy {
    uint256 public mockValue;
    bool public mockValid;

    /// @notice Last assets pushed into `onLiveDeposit` by the vault.
    uint256 public lastLiveDeposit;
    uint256 public liveDepositCount;

    /// @notice Optional vault-authorization gate for `onLiveDeposit`. When zero
    ///         (default), the gate is disabled and any caller is allowed —
    ///         preserves backward compatibility with tests that prank in as
    ///         the vault without configuring this mock. When non-zero, mirrors
    ///         the production `BaseStrategy.onLiveDeposit` `onlyVault` check.
    address public configuredVault;

    function setValue(uint256 v, bool valid_) external {
        mockValue = v;
        mockValid = valid_;
    }

    /// @notice Configure the expected vault caller for `onLiveDeposit`. Pass
    ///         `address(0)` to disable the gate (default).
    function setConfiguredVault(address v) external {
        configuredVault = v;
    }

    function positionValue() external view returns (uint256, bool) {
        return (mockValue, mockValid);
    }

    // Stubs for the rest of IStrategy — vault doesn't call these in NAV tests.
    function initialize(address, address, bytes calldata) external pure {}

    function execute() external pure {}

    function settle() external pure {}

    function updateParams(bytes calldata) external pure {}

    function vault() external pure returns (address) {
        return address(0);
    }

    function proposer() external pure returns (address) {
        return address(0);
    }

    function executed() external pure returns (bool) {
        return true;
    }

    function name() external pure returns (string memory) {
        return "MockStrategyAdapter";
    }

    function onLiveDeposit(uint256 assets) external {
        // Default-disabled gate: backwards-compatible with existing tests that
        // call this directly. When `configuredVault` is set, the gate mirrors
        // production `BaseStrategy.onLiveDeposit` `onlyVault`.
        if (configuredVault != address(0)) {
            require(msg.sender == configuredVault, "MockStrategyAdapter: not vault");
        }
        lastLiveDeposit = assets;
        liveDepositCount++;
    }
}
