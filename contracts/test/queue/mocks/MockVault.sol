// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal mock implementing just enough surface area for VaultWithdrawalQueue
///         unit tests: share-token semantics, redemptionsLocked(), and a deterministic
///         redeem(shares, receiver, owner) hook.
contract MockVault is ERC20("MV", "MV") {
    bool public locked;
    address public queue;
    uint256 public redeemRate = 1e18; // assets per share, 1e18-scaled
    address public lastRedeemReceiver;
    address public lastRedeemOwner;

    function setQueue(address q) external {
        queue = q;
    }

    function setLocked(bool l) external {
        locked = l;
    }

    function setRedeemRate(uint256 r) external {
        redeemRate = r;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }

    function redemptionsLocked() external view returns (bool) {
        return locked;
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        require(msg.sender == queue || msg.sender == owner, "auth");
        _burn(owner, shares);
        lastRedeemReceiver = receiver;
        lastRedeemOwner = owner;
        assets = shares * redeemRate / 1e18;
    }
}
