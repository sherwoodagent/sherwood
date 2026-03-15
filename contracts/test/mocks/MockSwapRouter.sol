// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Mock Uniswap V3 SwapRouter for testing
/// @dev Returns a fixed exchange rate for simplicity. In production, the real router handles pricing.
contract MockSwapRouter {
    using SafeERC20 for IERC20;

    // Mock exchange rate: 1 tokenIn = exchangeRate tokenOut (scaled by 1e6)
    uint256 public exchangeRate = 1e6; // 1:1 default
    address public mockTokenOut; // What token to send on swap

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut) {
        // Pull tokenIn
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        // Calculate output
        amountOut = (params.amountIn * exchangeRate) / 1e6;
        require(amountOut >= params.amountOutMinimum, "Slippage exceeded");

        // Send tokenOut to recipient
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }

    function exactInput(ExactInputParams calldata params) external returns (uint256 amountOut) {
        // For multi-hop, decode first token from path
        // Path format: tokenIn (20 bytes) + fee (3 bytes) + tokenOut (20 bytes) + ...
        bytes memory path = params.path;
        address tokenIn;
        assembly {
            tokenIn := shr(96, mload(add(path, 32)))
        }

        // Pull tokenIn
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        // Calculate output
        amountOut = (params.amountIn * exchangeRate) / 1e6;
        require(amountOut >= params.amountOutMinimum, "Slippage exceeded");

        // Send mockTokenOut to recipient
        require(mockTokenOut != address(0), "Set mockTokenOut first");
        IERC20(mockTokenOut).safeTransfer(params.recipient, amountOut);
    }

    // Test helpers
    function setExchangeRate(uint256 rate) external {
        exchangeRate = rate;
    }

    function setMockTokenOut(address token) external {
        mockTokenOut = token;
    }
}
