// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IStrategy} from "../../src/interfaces/IStrategy.sol";

/// @notice Minimal IStrategy stub for vault NAV tests. Lets a test set
///         `(value, valid)` returned by `positionValue()`.
contract MockStrategyAdapter is IStrategy {
    uint256 public mockValue;
    bool public mockValid;

    function setValue(uint256 v, bool valid_) external {
        mockValue = v;
        mockValid = valid_;
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
}
