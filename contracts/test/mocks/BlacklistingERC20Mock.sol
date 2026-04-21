// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC-20 mock that can revert on transfers to a configured set of
///         "blacklisted" addresses, modeling USDC's on-chain blacklist. Used
///         to regression-test `SyndicateGovernor` settlement resilience when
///         any fee recipient (lead / co-proposer / protocol / vault owner)
///         becomes blacklisted mid-strategy. (W-1)
contract BlacklistingERC20Mock is ERC20 {
    uint8 private _decimals;

    mapping(address => bool) public blacklisted;

    error Blacklisted(address target);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Toggle blacklist state for an address. Transfers to or from
    ///         blacklisted addresses revert with `Blacklisted`.
    function setBlacklisted(address target, bool b) external {
        blacklisted[target] = b;
    }

    function _update(address from, address to, uint256 value) internal virtual override {
        if (blacklisted[from]) revert Blacklisted(from);
        if (blacklisted[to]) revert Blacklisted(to);
        super._update(from, to, value);
    }
}
