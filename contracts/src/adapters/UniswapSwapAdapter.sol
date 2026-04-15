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
            // V3 multi-hop via chained exactInputSingle calls.
            // SwapRouter02's exactInput computes wrong pool addresses for certain pairs
            // on Base, so we decompose the path and swap hop-by-hop using exactInputSingle
            // which always resolves pools correctly.
            bytes memory path = abi.decode(routeData, (bytes));
            address pathStart = _extractFirstAddress(path);
            if (pathStart != tokenIn) {
                path = _reversePath(path);
            }
            amountOut = _chainedSingleHops(path, amountIn, amountOutMin);
        } else {
            revert UnsupportedMode();
        }
    }

    /// @dev Execute a multi-hop swap as sequential exactInputSingle calls.
    ///      Intermediate tokens are held by this contract between hops.
    function _chainedSingleHops(bytes memory path, uint256 amountIn, uint256 amountOutMin)
        internal
        returns (uint256 amountOut)
    {
        uint256 len = path.length;
        require(len >= 43 && (len - 20) % 23 == 0, "invalid path length");
        uint256 numHops = (len - 20) / 23;

        uint256 currentAmount = amountIn;

        for (uint256 i; i < numHops; ++i) {
            address hopIn = _extractAddressAt(path, i * 23);
            uint24 fee = _extractFeeAt(path, i * 23 + 20);
            address hopOut = _extractAddressAt(path, i * 23 + 23);

            bool lastHop = (i == numHops - 1);

            // Approve router for intermediate tokens (first hop was approved in swap())
            if (i > 0) {
                IERC20(hopIn).forceApprove(address(v3Router), currentAmount);
            }

            currentAmount = v3Router.exactInputSingle(
                ISwapRouter.ExactInputSingleParams({
                    tokenIn: hopIn,
                    tokenOut: hopOut,
                    fee: fee,
                    recipient: lastHop ? msg.sender : address(this),
                    amountIn: currentAmount,
                    amountOutMinimum: lastHop ? amountOutMin : 0,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        amountOut = currentAmount;
    }

    /// @dev Extract a 20-byte address at an arbitrary byte offset in a packed path.
    function _extractAddressAt(bytes memory path, uint256 offset) internal pure returns (address addr) {
        require(path.length >= offset + 20, "path too short");
        assembly {
            addr := shr(96, mload(add(add(path, 32), offset)))
        }
    }

    /// @dev Extract a 3-byte uint24 fee at an arbitrary byte offset in a packed path.
    function _extractFeeAt(bytes memory path, uint256 offset) internal pure returns (uint24 fee) {
        require(path.length >= offset + 3, "path too short");
        assembly {
            fee := shr(232, mload(add(add(path, 32), offset)))
        }
    }

    /// @dev Extract the first 20-byte address from a packed V3 path.
    function _extractFirstAddress(bytes memory path) internal pure returns (address addr) {
        require(path.length >= 20, "path too short");
        assembly {
            addr := shr(96, mload(add(path, 32)))
        }
    }

    /// @dev Reverse a packed Uniswap V3 path (addr + fee + addr + fee + ...).
    ///      Each segment is 20 bytes (address) + 3 bytes (fee). Last element is 20 bytes.
    function _reversePath(bytes memory path) internal pure returns (bytes memory reversed) {
        uint256 len = path.length;
        // path layout: addr(20) [+ fee(3) + addr(20)]* — total = 20 + 23*n
        require(len >= 20 && (len - 20) % 23 == 0, "invalid path length");
        uint256 numHops = (len - 20) / 23;

        reversed = new bytes(len);
        uint256 writePos;

        // Write last address first
        uint256 lastAddrPos = 20 + numHops * 23;
        for (uint256 j; j < 20; ++j) {
            reversed[writePos++] = path[lastAddrPos - 20 + j];
        }

        // Walk backwards through hops
        for (uint256 i = numHops; i > 0; --i) {
            uint256 hopStart = (i - 1) * 23 + 20; // fee starts here
            // Copy fee (3 bytes)
            reversed[writePos++] = path[hopStart];
            reversed[writePos++] = path[hopStart + 1];
            reversed[writePos++] = path[hopStart + 2];
            // Copy address before this fee (20 bytes at hopStart - 20)
            uint256 addrStart = hopStart - 20;
            for (uint256 j; j < 20; ++j) {
                reversed[writePos++] = path[addrStart + j];
            }
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
