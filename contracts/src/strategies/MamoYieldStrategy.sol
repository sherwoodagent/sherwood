// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategy} from "../interfaces/IStrategy.sol";
import {IMamoStrategyFactory, IMamoERC20Strategy} from "../interfaces/IMamoStrategy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MamoYieldStrategy
 * @notice Deposit vault funds into Mamo for optimized yield across Moonwell core + Morpho vaults.
 *
 *   Execute: pull underlying from vault → create Mamo strategy → approve + deposit
 *   Settle:  withdrawAll from Mamo strategy → validate minRedeemAmount → push back to vault
 *
 *   Batch calls from governor:
 *     Execute: [underlying.approve(strategy, supplyAmount), strategy.execute()]
 *     Settle:  [strategy.settle()]
 *
 *   Tunable params (updatable by proposer between execution and settlement):
 *     - supplyAmount: how much underlying to supply (used on execute)
 *     - minRedeemAmount: minimum underlying to accept on redeem (slippage)
 */
contract MamoYieldStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ── Errors ──
    error InvalidAmount();
    error CreateStrategyFailed();
    error WithdrawFailed();

    // ── Storage (per-clone) ──
    address public underlying; // e.g., USDC
    address public mamoFactory; // Mamo StrategyFactory
    address public mamoStrategy; // Created Mamo strategy instance (set on execute)

    uint256 public supplyAmount; // underlying tokens to supply
    uint256 public minRedeemAmount; // minimum underlying to accept on redeem

    /// @inheritdoc IStrategy
    function name() external pure returns (string memory) {
        return "Mamo Yield";
    }

    /// @notice Decode: (address underlying, address mamoFactory, uint256 supplyAmount, uint256 minRedeemAmount)
    function _initialize(bytes calldata data) internal override {
        (address underlying_, address mamoFactory_, uint256 supplyAmount_, uint256 minRedeemAmount_) =
            abi.decode(data, (address, address, uint256, uint256));
        if (underlying_ == address(0) || mamoFactory_ == address(0)) revert ZeroAddress();
        if (supplyAmount_ == 0) revert InvalidAmount();

        underlying = underlying_;
        mamoFactory = mamoFactory_;
        supplyAmount = supplyAmount_;
        minRedeemAmount = minRedeemAmount_;
    }

    /// @notice Pull underlying from vault, create Mamo strategy, deposit
    function _execute() internal override {
        // Pull tokens from vault (vault must have approved us first via batch call)
        _pullFromVault(underlying, supplyAmount);

        // Create a Mamo strategy owned by this contract
        address mamoStrategy_ = IMamoStrategyFactory(mamoFactory).createStrategyForUser(address(this));
        if (mamoStrategy_ == address(0)) revert CreateStrategyFailed();
        mamoStrategy = mamoStrategy_;

        // Approve the Mamo strategy to pull our underlying (deposit does safeTransferFrom)
        IERC20(underlying).forceApprove(mamoStrategy_, supplyAmount);

        // Deposit into Mamo strategy
        IMamoERC20Strategy(mamoStrategy_).deposit(supplyAmount);
    }

    /// @notice Withdraw all from Mamo strategy, push underlying back to vault
    function _settle() internal override {
        // Withdraw all from Mamo strategy (we are the owner)
        IMamoERC20Strategy(mamoStrategy).withdrawAll();

        // Verify we got enough underlying back
        uint256 redeemed = IERC20(underlying).balanceOf(address(this));
        if (redeemed < minRedeemAmount) revert InvalidAmount();

        // Push everything back to the vault
        _pushAllToVault(underlying);
    }

    /// @notice Update params: (uint256 newSupplyAmount, uint256 newMinRedeemAmount)
    /// @dev Pass 0 to keep current value. Only proposer, only while Executed.
    function _updateParams(bytes calldata data) internal override {
        (uint256 newSupplyAmount, uint256 newMinRedeemAmount) = abi.decode(data, (uint256, uint256));
        if (newSupplyAmount > 0) supplyAmount = newSupplyAmount;
        if (newMinRedeemAmount > 0) minRedeemAmount = newMinRedeemAmount;
    }
}
