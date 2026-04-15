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
 *     Execute: [WETH.approve(strategy, amount), strategy.execute(), WETH.approve(strategy, 0)]
 *     Settle:  [strategy.settle()]
 *
 *   Slippage is expressed as *per-unit rates* (scaled by 1e18) so it works
 *   for both fixed and dynamic-all mode:
 *     - minWstethOutPerWeth:  min wstETH received per 1e18 WETH swapped (execute)
 *     - minWethOutPerWsteth:  min WETH received per 1e18 wstETH swapped (settle)
 *     minOut at swap time = (amountIn * rate) / 1e18
 *
 *   Tunable params (updatable by proposer):
 *     - minWstethOutPerWeth, minWethOutPerWsteth, deadlineOffset
 *     - supplyAmount: fixed WETH amount, or 0 to use the vault's full WETH balance at execute time
 */
contract WstETHMoonwellStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ── Errors ──
    error InvalidAmount();
    error MintFailed();
    error RedeemFailed();
    error SwapFailed();
    error AlreadySettledParams();

    // ── Initialization parameters ──
    struct InitParams {
        address weth;
        address wsteth;
        address mwsteth;
        address aeroRouter;
        address aeroFactory;
        uint256 supplyAmount;
        uint256 minWstethOutPerWeth; // rate (1e18): min wstETH per 1e18 WETH (execute swap)
        uint256 minWethOutPerWsteth; // rate (1e18): min WETH per 1e18 wstETH (settle swap)
        uint256 deadlineOffset; // seconds added to block.timestamp for swap deadlines
    }

    // ── Storage (per-clone) ──
    address public weth;
    address public wsteth;
    address public mwsteth;
    address public aeroRouter;
    address public aeroFactory;

    uint256 public supplyAmount;
    uint256 public minWstethOutPerWeth;
    uint256 public minWethOutPerWsteth;
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
        if (p.minWstethOutPerWeth == 0 || p.minWethOutPerWsteth == 0) revert InvalidAmount();

        weth = p.weth;
        wsteth = p.wsteth;
        mwsteth = p.mwsteth;
        aeroRouter = p.aeroRouter;
        aeroFactory = p.aeroFactory;
        supplyAmount = p.supplyAmount;
        minWstethOutPerWeth = p.minWstethOutPerWeth;
        minWethOutPerWsteth = p.minWethOutPerWsteth;
        deadlineOffset = p.deadlineOffset == 0 ? 300 : p.deadlineOffset;
    }

    /// @notice Pull WETH → swap to wstETH → supply to Moonwell
    function _execute() internal override {
        uint256 amountIn = supplyAmount == 0 ? IERC20(weth).balanceOf(vault()) : supplyAmount;
        if (amountIn == 0) revert InvalidAmount();

        // 1. Pull WETH from vault
        _pullFromVault(weth, amountIn);

        // 2. Swap WETH → wstETH via Aerodrome stable pool
        //    minOut scales with actual amountIn — safe for dynamic-all mode.
        uint256 minWstethOut = (amountIn * minWstethOutPerWeth) / 1e18;
        if (minWstethOut == 0) revert InvalidAmount();

        IERC20(weth).forceApprove(aeroRouter, amountIn);
        IAeroRouter.Route[] memory routes = new IAeroRouter.Route[](1);
        routes[0] = IAeroRouter.Route({from: weth, to: wsteth, stable: true, factory: aeroFactory});
        uint256[] memory amounts = IAeroRouter(aeroRouter)
            .swapExactTokensForTokens(amountIn, minWstethOut, routes, address(this), block.timestamp + deadlineOffset);
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
        //    minOut scales with actual wstETH balance — handles yield-accrued amounts safely.
        uint256 wstethBalance = IERC20(wsteth).balanceOf(address(this));
        if (wstethBalance > 0) {
            uint256 minWethOut = (wstethBalance * minWethOutPerWsteth) / 1e18;
            if (minWethOut == 0) revert InvalidAmount();

            IERC20(wsteth).forceApprove(aeroRouter, wstethBalance);
            IAeroRouter.Route[] memory routes = new IAeroRouter.Route[](1);
            routes[0] = IAeroRouter.Route({from: wsteth, to: weth, stable: true, factory: aeroFactory});
            IAeroRouter(aeroRouter)
                .swapExactTokensForTokens(
                    wstethBalance, minWethOut, routes, address(this), block.timestamp + deadlineOffset
                );
        }

        // 3. Push all WETH back to vault. The router already enforced per-swap
        //    slippage, but guard against a zero-balance edge case where the
        //    Moonwell redeem or Aero swap silently returned nothing — we must
        //    not silently "settle" a proposal with no funds returned.
        uint256 wethBalance = IERC20(weth).balanceOf(address(this));
        if (wethBalance == 0) revert InvalidAmount();
        _pushAllToVault(weth);

        // Push any residual dust
        _pushAllToVault(wsteth);
    }

    /**
     * @notice Update slippage params — allowed in Pending OR Executed state.
     * @dev Overrides BaseStrategy to relax the state check. Proposer can fix
     *      slippage before execution (Pending) or between execute/settle (Executed).
     *      Decode: (uint256 newMinWethOutPerWsteth, uint256 newMinWstethOutPerWeth, uint256 newDeadlineOffset)
     *      Pass 0 to keep current value.
     */
    function updateParams(bytes calldata data) external override onlyProposer {
        if (_state == State.Settled) revert AlreadySettledParams();
        _updateParams(data);
    }

    function _updateParams(bytes calldata data) internal override {
        (uint256 newMinWethOutPerWsteth, uint256 newMinWstethOutPerWeth, uint256 newDeadlineOffset) =
            abi.decode(data, (uint256, uint256, uint256));
        if (newMinWethOutPerWsteth > 0) minWethOutPerWsteth = newMinWethOutPerWsteth;
        if (newMinWstethOutPerWeth > 0) minWstethOutPerWeth = newMinWstethOutPerWeth;
        if (newDeadlineOffset > 0) deadlineOffset = newDeadlineOffset;
    }

    // ── positionValue ──
    // Inherits BaseStrategy's (0, false) default. On Base mainnet the
    // bridged Lido wstETH (ERC20Bridged via OssifiableProxy) does NOT
    // expose stEthPerToken / tokensPerStEth / any rate view — an earlier
    // impl here that called stEthPerToken reverted on the forked
    // mainnet integration test. The correct fix is to read Chainlink's
    // WSTETH/ETH feed (Base: 0x43a5C292A453A3bF3606fa856197f09D7B74251a),
    // which requires threading a new oracle address through InitParams
    // and all construction callers (CLI + scripts). Deferred to a
    // focused follow-up; keeping this stub honest in the meantime.
}
