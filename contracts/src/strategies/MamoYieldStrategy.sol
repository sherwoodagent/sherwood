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
 *   Execute: pull entire vault underlying balance → create Mamo strategy → approve + deposit
 *   Settle:  withdrawAll from Mamo strategy → validate minRedeemAmount → push back to vault
 *
 *   Batch calls from governor:
 *     Execute: [underlying.approve(strategy, vaultBalance), strategy.execute()]
 *     Settle:  [strategy.settle()]
 *
 *   No tunable params — minRedeemAmount is set at initialization and immutable.
 */
contract MamoYieldStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ── Errors ──
    error InvalidAmount();
    error CreateStrategyFailed();
    error DepositFailed();
    error NoTunableParams();
    error UntrustedMamoStrategy();

    // ── Storage (per-clone) ──
    address public underlying; // e.g., USDC
    address public mamoFactory; // Mamo StrategyFactory
    address public mamoStrategy; // Created Mamo strategy instance (set on execute)

    uint256 public supplyAmount; // actual amount supplied (set on execute from vault balance)
    uint256 public minRedeemAmount; // minimum underlying to accept on redeem
    bytes32 public allowedStrategyCodehash; // expected Mamo strategy bytecode hash

    /// @inheritdoc IStrategy
    function name() external pure returns (string memory) {
        return "Mamo Yield";
    }

    /// @notice Decode: (address underlying, address mamoFactory, uint256 minRedeemAmount,
    ///         bytes32 allowedStrategyCodehash)
    /// @dev `allowedStrategyCodehash` pins the bytecode hash that Mamo's
    ///      factory must return from `createStrategyForUser`. Set it from
    ///      a known-good audited Mamo strategy version. Pass `bytes32(0)`
    ///      to skip the check (NOT recommended for mainnet).
    function _initialize(bytes calldata data) internal override {
        (address underlying_, address mamoFactory_, uint256 minRedeemAmount_, bytes32 allowedStrategyCodehash_) =
            abi.decode(data, (address, address, uint256, bytes32));
        if (underlying_ == address(0) || mamoFactory_ == address(0)) revert ZeroAddress();

        underlying = underlying_;
        mamoFactory = mamoFactory_;
        minRedeemAmount = minRedeemAmount_;
        allowedStrategyCodehash = allowedStrategyCodehash_;
    }

    /// @notice Pull entire vault underlying balance, create Mamo strategy, deposit
    function _execute() internal override {
        // Get the vault's full underlying balance and pull it all
        uint256 amount = IERC20(underlying).balanceOf(vault());
        if (amount == 0) revert InvalidAmount();
        _pullFromVault(underlying, amount);
        supplyAmount = amount; // record for reference

        // Create a Mamo strategy owned by this contract
        address mamoStrategy_ = IMamoStrategyFactory(mamoFactory).createStrategyForUser(address(this));
        if (mamoStrategy_ == address(0)) revert CreateStrategyFailed();
        mamoStrategy = mamoStrategy_;

        // Verify the factory returned a contract, not an EOA
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(mamoStrategy_)
        }
        if (codeSize == 0) revert CreateStrategyFailed();

        // Optionally pin the Mamo strategy's bytecode hash so a compromised
        // Mamo factory can't swap in attacker bytecode that accepts the deposit
        // and funnels funds to a third party.
        if (allowedStrategyCodehash != bytes32(0) && mamoStrategy_.codehash != allowedStrategyCodehash) {
            revert UntrustedMamoStrategy();
        }

        // Approve the Mamo strategy to pull our underlying (deposit does safeTransferFrom)
        IERC20(underlying).forceApprove(mamoStrategy_, amount);

        // Deposit into Mamo strategy and verify funds left this contract
        uint256 balanceBefore = IERC20(underlying).balanceOf(address(this));
        IMamoERC20Strategy(mamoStrategy_).deposit(amount);
        uint256 balanceAfter = IERC20(underlying).balanceOf(address(this));
        if (balanceBefore - balanceAfter < amount) revert DepositFailed();
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

    /// @notice No param updates for this strategy.
    function _updateParams(bytes calldata) internal pure override {
        revert NoTunableParams();
    }

    // ── positionValue ──
    // Inherits BaseStrategy's (0, false) default. The Mamo strategy
    // instance only exposes `deposit` / `withdraw` / `withdrawAll` — no
    // public balance or value getter — so there is no onchain path to
    // a current position value until Mamo adds one upstream.
}
