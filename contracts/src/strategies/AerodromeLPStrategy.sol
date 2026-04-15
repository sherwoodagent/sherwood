// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategy} from "../interfaces/IStrategy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal Aerodrome Router interface (addLiquidity / removeLiquidity)
interface IAeroRouter {
    function addLiquidity(
        address tokenA,
        address tokenB,
        bool stable,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);

    function removeLiquidity(
        address tokenA,
        address tokenB,
        bool stable,
        uint256 liquidity,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB);
}

/// @notice Minimal Aerodrome Gauge interface (deposit / withdraw / getReward)
interface IAeroGauge {
    function deposit(uint256 _amount) external;
    function withdraw(uint256 _amount) external;
    function getReward(address _account) external;
    function balanceOf(address _account) external view returns (uint256);
    function rewardToken() external view returns (address);
    function stakingToken() external view returns (address);
}

/**
 * @title AerodromeLPStrategy
 * @notice Provide liquidity on Aerodrome (Base) and optionally stake LP in a Gauge
 *         for AERO rewards.
 *
 *   Execute: pull tokenA + tokenB from vault → addLiquidity → stake LP in gauge
 *   Settle:  unstake LP → claim AERO → removeLiquidity → push all tokens to vault
 *
 *   Batch calls from governor:
 *     Execute: [tokenA.approve(strategy, amountA), tokenB.approve(strategy, amountB), strategy.execute()]
 *     Settle:  [strategy.settle()]
 *
 *   If the vault only holds one asset (e.g., USDC), the agent should add a swap
 *   call before the strategy in the execute batch to acquire tokenB.
 *
 *   Tunable params (updatable by proposer between execution and settlement):
 *     - minAmountAOut: minimum tokenA to accept on removeLiquidity
 *     - minAmountBOut: minimum tokenB to accept on removeLiquidity
 */
contract AerodromeLPStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ── Errors ──
    error InvalidAmount();
    error GaugeMismatch();

    // ── Storage (per-clone) ──
    address public tokenA;
    address public tokenB;
    bool public stable; // true = stable pool (correlated assets), false = volatile
    address public factory; // Aerodrome pool factory
    address public router; // Aerodrome Router
    address public gauge; // Aerodrome Gauge (address(0) if no staking)
    address public lpToken; // Pool LP token address

    uint256 public amountADesired; // tokenA to provide
    uint256 public amountBDesired; // tokenB to provide
    uint256 public amountAMin; // min tokenA accepted on add (slippage)
    uint256 public amountBMin; // min tokenB accepted on add (slippage)

    uint256 public minAmountAOut; // min tokenA on remove (slippage)
    uint256 public minAmountBOut; // min tokenB on remove (slippage)

    /// @inheritdoc IStrategy
    function name() external pure returns (string memory) {
        return "Aerodrome LP";
    }

    /// @notice Initialization parameters (struct to avoid stack-too-deep)
    struct InitParams {
        address tokenA;
        address tokenB;
        bool stable;
        address factory;
        address router;
        address gauge; // address(0) to skip gauge staking
        address lpToken;
        uint256 amountADesired;
        uint256 amountBDesired;
        uint256 amountAMin;
        uint256 amountBMin;
        uint256 minAmountAOut;
        uint256 minAmountBOut;
    }

    /// @notice Decode: InitParams struct
    function _initialize(bytes calldata data) internal override {
        InitParams memory p = abi.decode(data, (InitParams));

        if (p.tokenA == address(0) || p.tokenB == address(0)) revert ZeroAddress();
        if (p.router == address(0) || p.lpToken == address(0)) revert ZeroAddress();
        if (p.amountADesired == 0 && p.amountBDesired == 0) revert InvalidAmount();
        // Require at least one settlement slippage param to prevent sandwich attacks
        if (p.minAmountAOut == 0 && p.minAmountBOut == 0) revert InvalidAmount();

        // If gauge is set, verify its staking token matches the LP
        if (p.gauge != address(0)) {
            if (IAeroGauge(p.gauge).stakingToken() != p.lpToken) revert GaugeMismatch();
        }

        tokenA = p.tokenA;
        tokenB = p.tokenB;
        stable = p.stable;
        factory = p.factory;
        router = p.router;
        gauge = p.gauge;
        lpToken = p.lpToken;
        amountADesired = p.amountADesired;
        amountBDesired = p.amountBDesired;
        amountAMin = p.amountAMin;
        amountBMin = p.amountBMin;
        minAmountAOut = p.minAmountAOut;
        minAmountBOut = p.minAmountBOut;
    }

    /// @notice Pull tokens from vault, add liquidity, optionally stake LP
    function _execute() internal override {
        // Pull tokens from vault (vault must have approved us via batch calls)
        if (amountADesired > 0) _pullFromVault(tokenA, amountADesired);
        if (amountBDesired > 0) _pullFromVault(tokenB, amountBDesired);

        // Approve router
        IERC20(tokenA).forceApprove(router, amountADesired);
        IERC20(tokenB).forceApprove(router, amountBDesired);

        // Add liquidity — LP tokens minted to this contract
        (,, uint256 liquidity) = IAeroRouter(router)
            .addLiquidity(
                tokenA,
                tokenB,
                stable,
                amountADesired,
                amountBDesired,
                amountAMin,
                amountBMin,
                address(this), // LP tokens to strategy
                block.timestamp // deadline = now (called atomically)
            );

        // Stake LP in gauge if configured
        if (gauge != address(0) && liquidity > 0) {
            IERC20(lpToken).forceApprove(gauge, liquidity);
            IAeroGauge(gauge).deposit(liquidity);
        }

        // Return any dust back to vault (router may not use full amounts)
        _pushAllToVault(tokenA);
        _pushAllToVault(tokenB);
    }

    /// @notice Unstake LP, claim rewards, remove liquidity, push all back to vault
    function _settle() internal override {
        uint256 lpBalance;

        // Unstake from gauge if staked
        if (gauge != address(0)) {
            lpBalance = IAeroGauge(gauge).balanceOf(address(this));
            if (lpBalance > 0) {
                IAeroGauge(gauge).withdraw(lpBalance);
            }
            // Claim AERO rewards
            IAeroGauge(gauge).getReward(address(this));
        }

        // Get total LP balance (could be unstaked or never staked)
        lpBalance = IERC20(lpToken).balanceOf(address(this));

        if (lpBalance > 0) {
            // Approve router to spend LP tokens
            IERC20(lpToken).forceApprove(router, lpBalance);

            // Remove liquidity
            IAeroRouter(router)
                .removeLiquidity(
                    tokenA,
                    tokenB,
                    stable,
                    lpBalance,
                    minAmountAOut,
                    minAmountBOut,
                    address(this), // tokens to strategy
                    block.timestamp
                );
        }

        // Push everything back to vault
        _pushAllToVault(tokenA);
        _pushAllToVault(tokenB);

        // Push AERO rewards to vault if any
        if (gauge != address(0)) {
            address rewardToken = IAeroGauge(gauge).rewardToken();
            _pushAllToVault(rewardToken);
        }
    }

    /**
     * @notice Update settlement slippage params
     * @dev Decode: (uint256 newMinAmountAOut, uint256 newMinAmountBOut)
     *      Pass 0 to keep current value. Only proposer, only while Executed.
     */
    function _updateParams(bytes calldata data) internal override {
        (uint256 newMinAmountAOut, uint256 newMinAmountBOut) = abi.decode(data, (uint256, uint256));
        if (newMinAmountAOut > 0) minAmountAOut = newMinAmountAOut;
        if (newMinAmountBOut > 0) minAmountBOut = newMinAmountBOut;
    }

    // ── positionValue ──
    // Inherits BaseStrategy's (0, false) default. Deferred to a follow-up:
    // requires decomposing the LP (including any gauge-staked portion) via
    // pool reserves + totalSupply, converting the non-asset leg through an
    // Aerodrome quote, and correctly handling the stable vs volatile
    // pricing curves. See issue #188 for rationale.
}
