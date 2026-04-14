// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategy} from "../interfaces/IStrategy.sol";
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

/// @notice Venice staking contract interface
interface IVeniceStaking {
    function stake(address recipient, uint256 amount) external;
}

/**
 * @title VeniceInferenceStrategy
 * @notice Loan-model strategy: vault lends asset to an agent for Venice private
 *         inference. The agent stakes VVV for sVVV (their inference license),
 *         uses Venice to run off-chain strategies, and repays the vault in the
 *         vault's asset (principal + profit from their off-chain work).
 *
 *         sVVV is non-transferrable on Base — it stays with the agent permanently.
 *         The agent's proposal must justify the inference cost and repayment plan.
 *
 *   Execute: pull asset → [swap to VVV if needed] → stake → agent gets sVVV
 *   Settle:  agent repays vault in vault asset (principal + profit)
 *
 *   Two execution paths (determined by asset vs vvv):
 *     1. Direct: vault holds VVV → stake immediately
 *     2. Swap:   vault holds USDC → Aerodrome swap to VVV → stake
 *
 *   Batch calls from governor:
 *     Execute: [asset.approve(strategy, assetAmount), strategy.execute()]
 *     Settle:  [strategy.settle()]
 *
 *   Pre-requisite: agent must call asset.approve(strategy, repaymentAmount)
 *   before settlement. The agent earns off-chain and repays in vault asset.
 *
 *   Tunable params (updatable by proposer between execution and settlement):
 *     - repaymentAmount: total amount agent will repay (principal + profit)
 *     - minVVV: minimum VVV from swap (swap path only)
 *     - deadlineOffset: seconds for swap deadline (swap path only)
 */
contract VeniceInferenceStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ── Errors ──
    error InvalidAmount();
    error SwapFailed();
    error NoAgent();

    // ── Initialization parameters ──
    struct InitParams {
        address asset; // token pulled from vault (VVV for direct, or USDC etc. for swap)
        address weth; // intermediate token for multi-hop swap (ignored if direct or singleHop)
        address vvv; // VVV token
        address sVVV; // sVVV staking contract (also ERC-20)
        address aeroRouter; // Aerodrome router (address(0) if asset == vvv)
        address aeroFactory; // Aerodrome factory (address(0) if asset == vvv)
        address agent; // single agent wallet receiving sVVV (the proposer)
        uint256 assetAmount; // amount of asset to pull from vault (the "loan")
        uint256 minVVV; // min VVV output from swap (0 if asset == vvv)
        uint256 deadlineOffset; // seconds added to block.timestamp for swap deadline
        bool singleHop; // true for direct asset→VVV swap (no WETH hop)
    }

    // ── Storage (per-clone) ──
    address public asset;
    address public weth;
    address public vvv;
    address public sVVV;
    address public aeroRouter;
    address public aeroFactory;
    address public agent;

    uint256 public assetAmount;
    uint256 public minVVV;
    uint256 public deadlineOffset;
    bool public singleHop;

    uint256 public stakedAmount; // VVV staked during execute (for reference)
    uint256 public repaymentAmount; // amount agent must repay in vault asset (defaults to assetAmount)

    /// @inheritdoc IStrategy
    function name() external pure returns (string memory) {
        return "Venice Inference";
    }

    /// @notice Whether this clone swaps asset→VVV or receives VVV directly
    function needsSwap() public view returns (bool) {
        return asset != vvv;
    }

    /// @notice Decode: InitParams struct
    function _initialize(bytes calldata data) internal override {
        InitParams memory p = abi.decode(data, (InitParams));

        if (p.asset == address(0) || p.vvv == address(0) || p.sVVV == address(0)) revert ZeroAddress();
        if (p.agent == address(0)) revert NoAgent();
        if (p.assetAmount == 0) revert InvalidAmount();

        // If asset != vvv, we need swap infra
        if (p.asset != p.vvv) {
            if (p.aeroRouter == address(0) || p.aeroFactory == address(0)) revert ZeroAddress();
            if (!p.singleHop && p.weth == address(0)) revert ZeroAddress();
            if (p.minVVV == 0) revert InvalidAmount();
        }

        asset = p.asset;
        weth = p.weth;
        vvv = p.vvv;
        sVVV = p.sVVV;
        aeroRouter = p.aeroRouter;
        aeroFactory = p.aeroFactory;
        agent = p.agent;
        assetAmount = p.assetAmount;
        minVVV = p.minVVV;
        deadlineOffset = p.deadlineOffset == 0 ? 300 : p.deadlineOffset;
        singleHop = p.singleHop;

        // Default repayment = principal (no profit). Agent updates via updateParams.
        repaymentAmount = p.assetAmount;
    }

    /// @notice Pull asset from vault → [swap to VVV if needed] → stake to agent
    function _execute() internal override {
        // 1. Pull asset from vault
        _pullFromVault(asset, assetAmount);

        uint256 vvvToStake;

        if (needsSwap()) {
            // 2a. Swap asset → VVV via Aerodrome
            IERC20(asset).forceApprove(aeroRouter, assetAmount);

            IAeroRouter.Route[] memory routes;
            if (singleHop) {
                routes = new IAeroRouter.Route[](1);
                routes[0] = IAeroRouter.Route({from: asset, to: vvv, stable: false, factory: aeroFactory});
            } else {
                routes = new IAeroRouter.Route[](2);
                routes[0] = IAeroRouter.Route({from: asset, to: weth, stable: false, factory: aeroFactory});
                routes[1] = IAeroRouter.Route({from: weth, to: vvv, stable: false, factory: aeroFactory});
            }

            uint256[] memory amounts = IAeroRouter(aeroRouter)
                .swapExactTokensForTokens(assetAmount, minVVV, routes, address(this), block.timestamp + deadlineOffset);
            vvvToStake = amounts[amounts.length - 1];
            if (vvvToStake == 0) revert SwapFailed();
        } else {
            // 2b. Asset is VVV — stake directly
            vvvToStake = assetAmount;
        }

        // 3. Stake VVV to agent — sVVV is non-transferrable and stays with agent
        IERC20(vvv).forceApprove(sVVV, vvvToStake);
        IVeniceStaking(sVVV).stake(agent, vvvToStake);
        stakedAmount = vvvToStake;

        // 4. Push any dust back to vault
        if (needsSwap()) _pushAllToVault(asset);
        _pushAllToVault(vvv);
    }

    /// @notice Agent repays the vault in the vault's asset (principal + profit).
    /// @dev The agent must have approved this strategy for `repaymentAmount` of `asset`.
    ///      sVVV stays with the agent — it is their inference license.
    ///      The governor calculates P&L from vault balance diff and distributes fees.
    function _settle() internal override {
        address _vault = this.vault();
        IERC20(asset).safeTransferFrom(agent, _vault, repaymentAmount);
    }

    /**
     * @notice Update repayment amount and/or swap slippage params.
     * @dev Decode: (uint256 newRepayment, uint256 newMinVVV, uint256 newDeadlineOffset)
     *      Pass 0 to keep current value. Only proposer, only while Executed.
     *
     *      The agent should call this before settlement to set repaymentAmount
     *      to principal + profit earned from their off-chain strategy.
     */
    function _updateParams(bytes calldata data) internal override {
        (uint256 newRepayment, uint256 newMinVVV, uint256 newDeadlineOffset) =
            abi.decode(data, (uint256, uint256, uint256));
        if (newRepayment > 0) repaymentAmount = newRepayment;
        if (newMinVVV > 0) minVVV = newMinVVV;
        if (newDeadlineOffset > 0) deadlineOffset = newDeadlineOffset;
    }

    // ── positionValue ──
    // Inherits BaseStrategy's (0, false) default. Loan model — the vault's
    // asset was transferred to the agent at execute, and sVVV (held by the
    // agent, non-transferrable) is not an asset this strategy owns. There
    // is no mid-strategy position on this contract to value.
}
