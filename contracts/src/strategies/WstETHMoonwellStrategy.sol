// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategy} from "../interfaces/IStrategy.sol";
import {ICToken} from "../interfaces/ICToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Aerodrome Router swap interface
interface IAeroRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/**
 * @title WstETHMoonwellStrategy
 * @notice Single-hop yield strategy: WETH → wstETH → Moonwell.
 *         Stacks Lido staking yield + Moonwell lending yield.
 *
 *   Execute: pull WETH → swap to wstETH (Aerodrome stable pool) → mint mwstETH
 *   Settle:  redeem mwstETH → swap wstETH to WETH (Aerodrome stable pool) → push to vault
 *
 *   Batch calls from governor:
 *     Execute: [WETH.approve(strategy, supplyAmount), strategy.execute()]
 *     Settle:  [strategy.settle()]
 *
 *   Tunable params (updatable by proposer between execution and settlement):
 *     - minWethOut: minimum WETH to accept on final settle swap (slippage)
 *     - minWstethOut: minimum wstETH to accept on execute swap (slippage)
 *     - deadlineOffset: seconds added to block.timestamp for swap deadlines
 */
contract WstETHMoonwellStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ── Errors ──
    error InvalidAmount();
    error MintFailed();
    error RedeemFailed();
    error SwapFailed();

    // ── Initialization parameters ──
    struct InitParams {
        address weth;
        address wsteth;
        address mwsteth;
        address aeroRouter;
        address aeroFactory;
        uint256 supplyAmount;
        uint256 minWstethOut; // slippage: min wstETH from WETH→wstETH swap (execute)
        uint256 minWethOut; // slippage: min WETH from wstETH→WETH swap (settle)
        uint256 deadlineOffset; // seconds added to block.timestamp for swap deadlines
    }

    // ── Storage (per-clone) ──
    address public weth;
    address public wsteth;
    address public mwsteth;
    address public aeroRouter;
    address public aeroFactory;

    uint256 public supplyAmount;
    uint256 public minWstethOut;
    uint256 public minWethOut;
    uint256 public deadlineOffset;

    /// @inheritdoc IStrategy
    function name() external pure returns (string memory) {
        return "wstETH Moonwell Yield";
    }

    /// @notice Decode: InitParams struct
    function _initialize(bytes calldata data) internal override {
        InitParams memory p = abi.decode(data, (InitParams));

        if (p.weth == address(0) || p.wsteth == address(0) || p.mwsteth == address(0)) revert ZeroAddress();
        if (p.aeroRouter == address(0) || p.aeroFactory == address(0)) revert ZeroAddress();
        if (p.supplyAmount == 0) revert InvalidAmount();
        if (p.minWstethOut == 0 || p.minWethOut == 0) revert InvalidAmount();

        weth = p.weth;
        wsteth = p.wsteth;
        mwsteth = p.mwsteth;
        aeroRouter = p.aeroRouter;
        aeroFactory = p.aeroFactory;
        supplyAmount = p.supplyAmount;
        minWstethOut = p.minWstethOut;
        minWethOut = p.minWethOut;
        deadlineOffset = p.deadlineOffset == 0 ? 300 : p.deadlineOffset;
    }

    /// @notice Pull WETH → swap to wstETH → supply to Moonwell
    function _execute() internal override {
        // 1. Pull WETH from vault
        _pullFromVault(weth, supplyAmount);

        // 2. Swap WETH → wstETH via Aerodrome stable pool
        IERC20(weth).forceApprove(aeroRouter, supplyAmount);
        IAeroRouter.Route[] memory routes = new IAeroRouter.Route[](1);
        routes[0] = IAeroRouter.Route({from: weth, to: wsteth, stable: true, factory: aeroFactory});
        uint256[] memory amounts = IAeroRouter(aeroRouter)
            .swapExactTokensForTokens(
                supplyAmount, minWstethOut, routes, address(this), block.timestamp + deadlineOffset
            );
        uint256 wstethReceived = amounts[amounts.length - 1];
        if (wstethReceived == 0) revert SwapFailed();

        // 3. Supply wstETH to Moonwell (mint mwstETH)
        IERC20(wsteth).forceApprove(mwsteth, wstethReceived);
        uint256 err = ICToken(mwsteth).mint(wstethReceived);
        if (err != 0) revert MintFailed();

        // Push any dust back to vault
        _pushAllToVault(weth);
        _pushAllToVault(wsteth);
    }

    /// @notice Redeem mwstETH → swap wstETH to WETH → push to vault
    function _settle() internal override {
        // 1. Redeem all mwstETH from Moonwell
        uint256 mTokenBalance = ICToken(mwsteth).balanceOf(address(this));
        if (mTokenBalance > 0) {
            uint256 err = ICToken(mwsteth).redeem(mTokenBalance);
            if (err != 0) revert RedeemFailed();
        }

        // 2. Swap wstETH → WETH via Aerodrome stable pool
        uint256 wstethBalance = IERC20(wsteth).balanceOf(address(this));
        if (wstethBalance > 0) {
            IERC20(wsteth).forceApprove(aeroRouter, wstethBalance);
            IAeroRouter.Route[] memory routes = new IAeroRouter.Route[](1);
            routes[0] = IAeroRouter.Route({from: wsteth, to: weth, stable: true, factory: aeroFactory});
            IAeroRouter(aeroRouter)
                .swapExactTokensForTokens(
                    wstethBalance, minWethOut, routes, address(this), block.timestamp + deadlineOffset
                );
        }

        // 3. Push all WETH back to vault
        uint256 wethBalance = IERC20(weth).balanceOf(address(this));
        if (wethBalance < minWethOut) revert InvalidAmount();
        _pushAllToVault(weth);

        // Push any residual dust
        _pushAllToVault(wsteth);
    }

    /**
     * @notice Update settlement slippage params
     * @dev Decode: (uint256 newMinWethOut, uint256 newMinWstethOut, uint256 newDeadlineOffset)
     *      Pass 0 to keep current value. Only proposer, only while Executed.
     */
    function _updateParams(bytes calldata data) internal override {
        (uint256 newMinWethOut, uint256 newMinWstethOut, uint256 newDeadlineOffset) =
            abi.decode(data, (uint256, uint256, uint256));
        if (newMinWethOut > 0) minWethOut = newMinWethOut;
        if (newMinWstethOut > 0) minWstethOut = newMinWstethOut;
        if (newDeadlineOffset > 0) deadlineOffset = newDeadlineOffset;
    }
}
