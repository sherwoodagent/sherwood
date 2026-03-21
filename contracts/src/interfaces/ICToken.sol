// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal Compound/Moonwell cToken interface
interface ICToken {
    function mint(uint256 mintAmount) external returns (uint256);
    function redeemUnderlying(uint256 redeemAmount) external returns (uint256);
    function redeem(uint256 redeemTokens) external returns (uint256);
    function balanceOf(address owner) external view returns (uint256);
    function balanceOfUnderlying(address owner) external returns (uint256);
}
