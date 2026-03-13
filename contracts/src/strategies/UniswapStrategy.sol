// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal Uniswap V3 SwapRouter interface
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/**
 * @title UniswapStrategy
 * @notice Strategy contract for Uniswap V3 trading on Base.
 *         Agents swap tokens with configurable slippage protection.
 *         Used for memecoin trading strategy.
 */
contract UniswapStrategy {
    using SafeERC20 for IERC20;

    /// @notice Uniswap V3 SwapRouter
    ISwapRouter public immutable swapRouter;

    /// @notice The vault that owns this strategy
    address public immutable vault;

    /// @notice Maximum slippage in basis points (e.g., 100 = 1%)
    uint256 public maxSlippageBps;

    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);
    event MaxSlippageUpdated(uint256 newMaxSlippageBps);

    modifier onlyVault() {
        require(msg.sender == vault, "Only vault");
        _;
    }

    constructor(address vault_, address swapRouter_, uint256 maxSlippageBps_) {
        require(vault_ != address(0), "Invalid vault");
        require(swapRouter_ != address(0), "Invalid router");
        require(maxSlippageBps_ <= 1000, "Slippage too high"); // max 10%

        vault = vault_;
        swapRouter = ISwapRouter(swapRouter_);
        maxSlippageBps = maxSlippageBps_;
    }

    /// @notice Execute a swap on Uniswap V3
    /// @param tokenIn Address of the input token
    /// @param tokenOut Address of the output token
    /// @param amountIn Amount of tokenIn to swap
    /// @param amountOutMinimum Minimum acceptable output (slippage protection)
    /// @param fee Pool fee tier (500, 3000, 10000)
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMinimum, uint24 fee)
        external
        onlyVault
        returns (uint256 amountOut)
    {
        // Transfer tokens from vault
        IERC20(tokenIn).safeTransferFrom(vault, address(this), amountIn);

        // Approve router
        IERC20(tokenIn).approve(address(swapRouter), amountIn);

        // Execute swap — output goes directly to vault
        amountOut = swapRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: vault,
                amountIn: amountIn,
                amountOutMinimum: amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );

        emit Swapped(tokenIn, tokenOut, amountIn, amountOut);
    }

    /// @notice Update max slippage (vault admin only)
    function setMaxSlippage(uint256 newMaxSlippageBps) external onlyVault {
        require(newMaxSlippageBps <= 1000, "Slippage too high");
        maxSlippageBps = newMaxSlippageBps;
        emit MaxSlippageUpdated(newMaxSlippageBps);
    }
}
