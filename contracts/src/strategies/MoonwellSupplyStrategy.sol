// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategy} from "../interfaces/IStrategy.sol";
import {ICToken} from "../interfaces/ICToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IWETH {
    function deposit() external payable;
}

/**
 * @title MoonwellSupplyStrategy
 * @notice Supply USDC to Moonwell's mUSDC market to earn yield.
 *
 *   Execute: pull USDC from vault → approve → mint mUSDC
 *   Settle:  redeem all mUSDC → push USDC back to vault
 *
 *   Batch calls from governor:
 *     Execute: [USDC.approve(strategy, supplyAmount), strategy.execute()]
 *     Settle:  [strategy.settle()]
 *
 *   Tunable params (updatable by proposer between execution and settlement):
 *     - supplyAmount: how much underlying to supply (used on execute)
 *     - minRedeemAmount: minimum underlying to accept on redeem (slippage)
 */
contract MoonwellSupplyStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ── Errors ──
    error InvalidAmount();
    error MintFailed();
    error RedeemFailed();

    // ── Storage (per-clone) ──
    address public underlying; // e.g., USDC
    address public mToken; // e.g., mUSDC

    uint256 public supplyAmount; // underlying tokens to supply
    uint256 public minRedeemAmount; // minimum underlying to accept on redeem

    /// @inheritdoc IStrategy
    function name() external pure returns (string memory) {
        return "Moonwell Supply";
    }

    /// @notice Decode: (address underlying, address mToken, uint256 supplyAmount, uint256 minRedeemAmount)
    function _initialize(bytes calldata data) internal override {
        (address underlying_, address mToken_, uint256 supplyAmount_, uint256 minRedeemAmount_) =
            abi.decode(data, (address, address, uint256, uint256));
        if (underlying_ == address(0) || mToken_ == address(0)) revert ZeroAddress();
        if (supplyAmount_ == 0) revert InvalidAmount();

        underlying = underlying_;
        mToken = mToken_;
        supplyAmount = supplyAmount_;
        minRedeemAmount = minRedeemAmount_;
    }

    /// @notice Pull USDC from vault, supply to Moonwell
    function _execute() internal override {
        // Pull tokens from vault (vault must have approved us first via batch call)
        _pullFromVault(underlying, supplyAmount);

        // Approve mToken to spend our underlying
        IERC20(underlying).forceApprove(mToken, supplyAmount);

        // Mint mTokens (supply underlying to Moonwell)
        uint256 err = ICToken(mToken).mint(supplyAmount);
        if (err != 0) revert MintFailed();
    }

    /// @notice Redeem all mTokens from Moonwell, push underlying back to vault
    function _settle() internal override {
        // Redeem all mTokens we hold
        uint256 mTokenBalance = ICToken(mToken).balanceOf(address(this));
        if (mTokenBalance > 0) {
            uint256 err = ICToken(mToken).redeem(mTokenBalance);
            if (err != 0) revert RedeemFailed();
        }

        // Some markets (e.g. Moonwell mWETH) send native ETH instead of ERC20 WETH.
        // Wrap any received ETH back to WETH so the vault always receives ERC20 tokens.
        if (address(this).balance > 0) {
            IWETH(underlying).deposit{value: address(this).balance}();
        }

        // Verify we got enough underlying back
        uint256 redeemed = IERC20(underlying).balanceOf(address(this));
        if (redeemed < minRedeemAmount) revert InvalidAmount();

        // Push everything back to the vault
        _pushAllToVault(underlying);
    }

    /// @notice Accept ETH from Moonwell mWETH market (which sends native ETH on redeem)
    receive() external payable {}

    /// @notice Update params: (uint256 newSupplyAmount, uint256 newMinRedeemAmount)
    /// @dev Pass 0 to keep current value. Only proposer, only while Executed.
    function _updateParams(bytes calldata data) internal override {
        (uint256 newSupplyAmount, uint256 newMinRedeemAmount) = abi.decode(data, (uint256, uint256));
        if (newSupplyAmount > 0) supplyAmount = newSupplyAmount;
        if (newMinRedeemAmount > 0) minRedeemAmount = newMinRedeemAmount;
    }

    // ── positionValue ──

    /// @dev Current underlying value of the supplied position. Uses
    ///      `exchangeRateStored` (last-accrued) rather than accruing
    ///      fresh interest — the one-block staleness is acceptable for
    ///      a display-only readout and keeps this cheap + pure view.
    function _positionValue() internal view override returns (uint256, bool) {
        uint256 cBal = ICToken(mToken).balanceOf(address(this));
        if (cBal == 0) return (0, true);
        uint256 rate = ICToken(mToken).exchangeRateStored();
        return ((cBal * rate) / 1e18, true);
    }
}
