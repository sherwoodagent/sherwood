// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ISwapAdapter
/// @notice Abstraction layer for DEX swaps — strategy contracts call this
///         interface without knowing which DEX is used underneath.
interface ISwapAdapter {
    /// @notice Execute a swap
    /// @param tokenIn The token to sell
    /// @param tokenOut The token to buy
    /// @param amountIn Amount of tokenIn to swap
    /// @param amountOutMin Minimum acceptable output (0 to skip check)
    /// @param extraData Adapter-specific routing data (fee tiers, paths, etc.)
    /// @return amountOut Actual amount of tokenOut received
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, bytes calldata extraData)
        external
        returns (uint256 amountOut);

    /// @notice Get a quote without executing the swap
    /// @param tokenIn The token to sell
    /// @param tokenOut The token to buy
    /// @param amountIn Amount of tokenIn to quote
    /// @param extraData Adapter-specific routing data
    /// @return amountOut Estimated amount of tokenOut
    function quote(address tokenIn, address tokenOut, uint256 amountIn, bytes calldata extraData)
        external
        returns (uint256 amountOut);
}
