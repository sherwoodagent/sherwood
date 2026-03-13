// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal mock strategy that pulls assets from vault and holds them
contract MockStrategy {
    using SafeERC20 for IERC20;

    address public immutable vault;
    IERC20 public immutable asset;

    constructor(address vault_, address asset_) {
        vault = vault_;
        asset = IERC20(asset_);
    }

    function execute(uint256 amount) external {
        // Pull assets from vault (vault must have approved this contract)
        asset.safeTransferFrom(vault, address(this), amount);
    }
}
