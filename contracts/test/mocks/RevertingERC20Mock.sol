// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC20 that can be toggled to revert on `transfer(to, *)` for a
///         specific recipient — used to exercise the `_pendingBurn` fallback
///         path in GuardianRegistry where a single failed burn transfer must
///         be queued for retry via `flushBurn` (spec §3.1).
contract RevertingERC20Mock is ERC20 {
    uint8 private _decimals;
    mapping(address => bool) public transferBlocked;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTransferBlocked(address to, bool blocked) external {
        transferBlocked[to] = blocked;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (transferBlocked[to]) revert("transfer blocked");
        return super.transfer(to, amount);
    }
}
