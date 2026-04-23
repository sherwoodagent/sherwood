// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal IERC4626-compatible mock exposing totalAssets() and owner()
///         for GuardianRegistry bond / rotation tests. Not a full vault — only
///         the surface area consumed by requiredOwnerBond and future tasks.
contract MockERC4626Vault {
    uint256 public totalAssets;
    address public owner;

    function setTotalAssets(uint256 v) external {
        totalAssets = v;
    }

    function setOwner(address o) external {
        owner = o;
    }
}
