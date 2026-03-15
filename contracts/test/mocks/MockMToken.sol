// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock Moonwell mToken for testing
contract MockMToken is ERC20 {
    using SafeERC20 for IERC20;

    address public underlyingAsset;
    uint256 public borrowBalance;
    uint256 public exchangeRateStored_;
    bool public shouldFail;

    constructor(address underlying_, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        underlyingAsset = underlying_;
        exchangeRateStored_ = 1e18; // 1:1 initially
    }

    function underlying() external view returns (address) {
        return underlyingAsset;
    }

    function mint(uint256 mintAmount) external returns (uint256) {
        if (shouldFail) return 1;
        IERC20(underlyingAsset).safeTransferFrom(msg.sender, address(this), mintAmount);
        _mint(msg.sender, mintAmount); // 1:1 for simplicity
        return 0;
    }

    function borrow(uint256 borrowAmount) external returns (uint256) {
        if (shouldFail) return 1;
        // Transfer underlying to borrower
        IERC20(underlyingAsset).safeTransfer(msg.sender, borrowAmount);
        borrowBalance += borrowAmount;
        return 0;
    }

    function repayBorrow(uint256 repayAmount) external returns (uint256) {
        if (shouldFail) return 1;
        IERC20(underlyingAsset).safeTransferFrom(msg.sender, address(this), repayAmount);
        borrowBalance -= repayAmount;
        return 0;
    }

    function redeemUnderlying(uint256 redeemAmount) external returns (uint256) {
        if (shouldFail) return 1;
        _burn(msg.sender, redeemAmount); // 1:1
        IERC20(underlyingAsset).safeTransfer(msg.sender, redeemAmount);
        return 0;
    }

    function borrowBalanceCurrent(address) external view returns (uint256) {
        return borrowBalance;
    }

    function getAccountSnapshot(address account)
        external
        view
        returns (uint256 err, uint256 mTokenBalance, uint256 borrowBal, uint256 exchangeRate)
    {
        return (0, balanceOf(account), borrowBalance, exchangeRateStored_);
    }

    // Test helpers
    function setShouldFail(bool fail) external {
        shouldFail = fail;
    }

    function fundUnderlying(uint256 amount) external {
        // For borrow liquidity — caller must have transferred underlying here
    }
}
