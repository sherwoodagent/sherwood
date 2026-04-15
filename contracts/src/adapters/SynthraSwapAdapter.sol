// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Synthra Router interface (SwapRouter02 — Uniswap V3 compatible, no deadline)
interface ISynthraRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external returns (uint256 amountOut);
}

/// @notice Synthra Quoter interface (Uniswap V3 QuoterV2 compatible)
interface ISynthraQuoter {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut);
}

/**
 * @title SynthraSwapAdapter
 * @notice ISwapAdapter implementation for Synthra DEX on Robinhood Chain.
 *         Synthra uses a Uniswap V3-compatible interface with an additional
 *         0.1% treasury fee deducted automatically from swaps.
 *
 *   extraData encoding:
 *     Single-hop: abi.encode(uint24 fee)
 *     Multi-hop:  abi.encode(uint24 fee, bytes path)  — path is packed (token+fee+token...)
 *
 *   The caller (strategy) must approve this adapter to spend tokenIn before calling swap().
 */
contract SynthraSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    ISynthraRouter public immutable router;
    ISynthraQuoter public immutable quoter;

    error ZeroAddress();

    constructor(address _router, address _quoter) {
        if (_router == address(0) || _quoter == address(0)) revert ZeroAddress();
        router = ISynthraRouter(_router);
        quoter = ISynthraQuoter(_quoter);
    }

    /// @inheritdoc ISwapAdapter
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, bytes calldata extraData)
        external
        override
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(router), amountIn);

        if (extraData.length == 32) {
            // Single-hop: extraData = abi.encode(uint24 fee)
            uint24 fee = abi.decode(extraData, (uint24));
            amountOut = router.exactInputSingle(
                ISynthraRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: msg.sender,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMin,
                    sqrtPriceLimitX96: 0
                })
            );
        } else {
            // Multi-hop: extraData = abi.encode(uint24 fee, bytes path)
            (, bytes memory path) = abi.decode(extraData, (uint24, bytes));
            amountOut = router.exactInput(
                ISynthraRouter.ExactInputParams({
                    path: path, recipient: msg.sender, amountIn: amountIn, amountOutMinimum: amountOutMin
                })
            );
        }
    }

    /// @inheritdoc ISwapAdapter
    function quote(address tokenIn, address tokenOut, uint256 amountIn, bytes calldata extraData)
        external
        override
        returns (uint256 amountOut)
    {
        uint24 fee = abi.decode(extraData, (uint24));
        amountOut = quoter.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
    }
}
