// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// ── Uniswap V3 interfaces ──

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

    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

interface IQuoterV2 {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    )
        external
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
}

// ── Uniswap V4 interfaces (minimal) ──

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/**
 * @title UniswapSwapAdapter
 * @notice ISwapAdapter implementation supporting Uniswap V3 single-hop and multi-hop swaps.
 *         Designed for chains with Uniswap deployed (Base, Ethereum, etc.).
 *
 *   extraData encoding (mode determines swap type):
 *     Mode 0 — V3 single-hop:  abi.encode(uint8(0), abi.encode(uint24 fee))
 *     Mode 1 — V3 multi-hop:   abi.encode(uint8(1), v3Path)
 *
 *   V4 support (modes 2-4) can be added later when needed.
 *
 *   The caller (strategy) must approve this adapter to spend tokenIn before calling swap().
 */
contract UniswapSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    ISwapRouter public immutable v3Router;
    IQuoterV2 public immutable quoter;

    error ZeroAddress();
    error UnsupportedMode();

    constructor(address _v3Router, address _quoter) {
        if (_v3Router == address(0) || _quoter == address(0)) revert ZeroAddress();
        v3Router = ISwapRouter(_v3Router);
        quoter = IQuoterV2(_quoter);
    }

    /// @inheritdoc ISwapAdapter
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, bytes calldata extraData)
        external
        override
        returns (uint256 amountOut)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenIn).forceApprove(address(v3Router), amountIn);

        uint8 mode = uint8(bytes1(extraData[:1]));
        bytes calldata routeData = extraData[1:];

        if (mode == 0) {
            // V3 single-hop
            uint24 fee = abi.decode(routeData, (uint24));
            amountOut = v3Router.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    fee: fee,
                    recipient: msg.sender,
                    amountIn: amountIn,
                    amountOutMinimum: amountOutMin,
                    sqrtPriceLimitX96: 0
                })
            );
        } else if (mode == 1) {
            // V3 multi-hop
            bytes memory path = abi.decode(routeData, (bytes));
            amountOut = v3Router.exactInput(
                ISwapRouter.ExactInputParams({
                    path: path, recipient: msg.sender, amountIn: amountIn, amountOutMinimum: amountOutMin
                })
            );
        } else {
            revert UnsupportedMode();
        }
    }

    /// @inheritdoc ISwapAdapter
    function quote(address tokenIn, address tokenOut, uint256 amountIn, bytes calldata extraData)
        external
        override
        returns (uint256 amountOut)
    {
        uint8 mode = uint8(bytes1(extraData[:1]));
        bytes calldata routeData = extraData[1:];

        if (mode == 0) {
            uint24 fee = abi.decode(routeData, (uint24));
            (amountOut,,,) = quoter.quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, 0);
        } else {
            revert UnsupportedMode();
        }
    }
}
