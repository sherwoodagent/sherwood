// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal interface for Mamo's StrategyFactory
interface IMamoStrategyFactory {
    function createStrategyForUser(address user) external returns (address strategy);
}

/// @notice Minimal interface for a Mamo ERC20 strategy instance
interface IMamoERC20Strategy {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function withdrawAll() external;
}
