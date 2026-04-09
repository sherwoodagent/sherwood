// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IStrategy} from "./IStrategy.sol";

/**
 * @title IHyperliquidPerpStrategy
 * @notice Interface for the Hyperliquid perpetual trading strategy.
 *         Uses HyperEVM precompiles for on-chain perp trading — no keeper.
 */
interface IHyperliquidPerpStrategy is IStrategy {
    // ── Events ──
    event PositionOpened(uint32 asset, bool isBuy, uint64 limitPx, uint64 sz, uint32 leverage);
    event PositionClosed(uint32 asset, uint64 limitPx, uint64 sz);
    event StopLossUpdated(uint64 triggerPx);
    event FundsParked(uint256 amount);
    event Settled();
    event FundsSwept(uint256 amount);
    event LeverageUpdated(uint32 asset, uint32 leverage);

    // ── Views ──
    function asset() external view returns (address);
    function depositAmount() external view returns (uint256);
    function minReturnAmount() external view returns (uint256);
    function perpAssetIndex() external view returns (uint32);
    function leverage() external view returns (uint32);
    function hasActiveStopLoss() external view returns (bool);
    function settled() external view returns (bool);
    function swept() external view returns (bool);
    function maxPositionSize() external view returns (uint256);
    function maxTradesPerDay() external view returns (uint32);

    /// @notice Push USDC to vault after async transfer completes. Callable by anyone.
    function sweepToVault() external;
}
