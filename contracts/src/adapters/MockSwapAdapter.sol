// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockSwapAdapter
 * @notice ISwapAdapter implementation with owner-configurable exchange rates.
 *         Used for Foundry unit tests — not for production.
 *
 *   Rates are stored per directional pair (tokenIn → tokenOut) and scaled by 1e18.
 *   A rate of 1e18 means 1:1, 2e18 means 1 tokenIn = 2 tokenOut.
 *
 *   The adapter must be pre-funded with output tokens.
 */
contract MockSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    /// @notice Exchange rate per directional pair: keccak256(tokenIn, tokenOut) → rate (1e18 scaled)
    mapping(bytes32 => uint256) public rates;

    uint256 public constant RATE_PRECISION = 1e18;

    error RateNotSet();
    error SlippageExceeded();

    function setRate(address tokenIn, address tokenOut, uint256 rate) external {
        rates[_pairKey(tokenIn, tokenOut)] = rate;
    }

    /// @inheritdoc ISwapAdapter
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes calldata /* extraData */
    )
        external
        override
        returns (uint256 amountOut)
    {
        uint256 rate = rates[_pairKey(tokenIn, tokenOut)];
        if (rate == 0) revert RateNotSet();

        amountOut = (amountIn * rate) / RATE_PRECISION;
        if (amountOut < amountOutMin) revert SlippageExceeded();

        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(msg.sender, amountOut);
    }

    /// @inheritdoc ISwapAdapter
    function quote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bytes calldata /* extraData */
    )
        external
        view
        override
        returns (uint256 amountOut)
    {
        uint256 rate = rates[_pairKey(tokenIn, tokenOut)];
        if (rate == 0) revert RateNotSet();
        amountOut = (amountIn * rate) / RATE_PRECISION;
    }

    function _pairKey(address tokenIn, address tokenOut) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tokenIn, tokenOut));
    }
}
