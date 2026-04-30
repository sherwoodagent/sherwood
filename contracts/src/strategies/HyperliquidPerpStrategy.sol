// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategy} from "../interfaces/IStrategy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {L1Write, TimeInForce, NO_CLOID} from "../hyperliquid/L1Write.sol";
import {L1Read, Position, SpotBalance, AccountMarginSummary} from "../hyperliquid/L1Read.sol";

/**
 * @title HyperliquidPerpStrategy
 * @notice On-chain perpetual trading strategy using HyperEVM precompiles.
 *
 *   USDC is pulled from the vault and transferred to perp margin via
 *   L1Write.sendUsdClassTransfer(). The proposer then triggers trades
 *   (open long, close position, update stop loss) via updateParams().
 *
 *   Settlement: _settle() closes positions + requests async USD transfer.
 *   sweepToVault() pushes USDC back to vault once it arrives on the EVM side.
 *   Callable by anyone (funds only go to vault). Repeatable for partial arrivals.
 *
 *   Position state is NOT tracked on-chain — L1Read.position2() is the source
 *   of truth. The proposer must check actual HyperCore state before acting.
 *
 *   NO off-chain keeper — all actions go through HyperCore precompiles.
 */
contract HyperliquidPerpStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ── Events ──
    event PositionOpened(uint32 asset, bool isBuy, uint64 limitPx, uint64 sz, uint32 leverage);
    event PositionClosed(uint32 asset, uint64 limitPx, uint64 sz);
    event StopLossUpdated(uint64 triggerPx);
    event FundsParked(uint256 amount);
    event Settled();
    event FundsSwept(uint256 amount);
    event LeverageUpdated(uint32 asset, uint32 leverage);

    // ── Errors ──
    error InvalidAmount();
    error InvalidAction();
    error DepositAmountTooLarge();
    error NotSweepable();
    error MaxTradesExceeded();
    error PositionTooLarge(uint256 actual, uint256 max);

    // ── Action types ──
    // Legacy single-asset actions (use perpAssetIndex from storage):
    uint8 constant ACTION_OPEN_LONG = 1;
    uint8 constant ACTION_CLOSE_POSITION = 2;
    uint8 constant ACTION_UPDATE_STOP_LOSS = 3; // reduce-only sell (for longs)
    uint8 constant ACTION_OPEN_SHORT = 4;
    uint8 constant ACTION_UPDATE_STOP_LOSS_SHORT = 5; // reduce-only buy (for shorts)
    // Multi-asset actions (assetIndex in calldata — one clone trades any perp):
    uint8 constant ACTION_OPEN_LONG_MULTI = 6; // (action, assetIndex, limitPx, sz, stopLossPx, stopLossSz)
    uint8 constant ACTION_OPEN_SHORT_MULTI = 7; // same encoding
    uint8 constant ACTION_CLOSE_MULTI = 8; // (action, assetIndex, isBuy, limitPx, sz)

    // ── CLOID constant for stop-loss tracking ──
    // Single fixed CLOID — only one GTC stop-loss is ever live at a time.
    // Each new stop-loss cancels the current one before placing a replacement.
    // Assumes HyperCore allows CLOID reuse after cancellation.
    uint128 constant STOP_LOSS_CLOID_BASE = 0x53544F504C4F53530000000000000000; // "STOPLOSS" prefix
    uint128 constant STOP_LOSS_CLOID = STOP_LOSS_CLOID_BASE + 1;

    // ── Storage (per-clone) ──
    IERC20 public asset;
    uint256 public depositAmount;
    uint32 public perpAssetIndex;
    uint32 public leverage;
    bool public leverageSentToCore; // Whether leverage has been set on HyperCore
    bool public hasActiveStopLoss; // Whether a GTC stop-loss is currently live
    bool public settled; // Whether _settle() has been called
    /// @dev Cumulative USDC pushed back to the vault across all sweepToVault() calls.
    ///      Off-chain accounting only — does not gate withdrawals.
    uint256 public cumulativeSwept;
    uint256 public maxPositionSize; // Max USDC in a single position (on-chain risk cap)
    uint32 public maxTradesPerDay; // Rate limit on trading actions per day
    uint32 public tradesToday; // Counter for today's trades
    uint256 public lastTradeReset; // Timestamp of last daily counter reset
    // Multi-asset tracking: all asset indices that have been traded via
    // ACTION_OPEN_*_MULTI. _settle() iterates this to close positions on
    // ALL assets, not just perpAssetIndex. Bounded by maxTradesPerDay.
    uint32[] public tradedAssets;
    mapping(uint32 => bool) public assetTraded; // dedup guard

    /// @inheritdoc IStrategy
    function name() external pure returns (string memory) {
        return "Hyperliquid Perp";
    }

    /// @notice Decode: (address asset, uint256 depositAmount, uint32 perpAssetIndex, uint32 leverage, uint256 maxPositionSize, uint32 maxTradesPerDay)
    /// @dev depositAmount_ == 0 means "use the vault's full asset balance at execute time" (dynamic-all mode).
    function _initialize(bytes calldata data) internal override {
        (
            address asset_,
            uint256 depositAmount_,
            uint32 perpAssetIndex_,
            uint32 leverage_,
            uint256 maxPositionSize_,
            uint32 maxTradesPerDay_
        ) = abi.decode(data, (address, uint256, uint32, uint32, uint256, uint32));

        if (asset_ == address(0)) revert ZeroAddress();
        if (depositAmount_ > type(uint64).max) revert DepositAmountTooLarge();
        if (leverage_ == 0 || leverage_ > 50) revert InvalidAmount();
        if (maxPositionSize_ == 0) revert InvalidAmount();
        if (maxTradesPerDay_ == 0) revert InvalidAmount();

        asset = IERC20(asset_);
        depositAmount = depositAmount_;
        perpAssetIndex = perpAssetIndex_;
        leverage = leverage_;
        maxPositionSize = maxPositionSize_;
        maxTradesPerDay = maxTradesPerDay_;
    }

    /// @notice Pull USDC from vault, transfer to perp margin via precompile
    /// @dev In dynamic-all mode (depositAmount == 0) the vault's current asset
    ///      balance is pulled in full. The uint64.max cap still applies to the
    ///      HyperCore transfer amount.
    function _execute() internal override {
        uint256 amountIn = depositAmount;
        if (amountIn == 0) {
            amountIn = IERC20(asset).balanceOf(vault());
        }
        if (amountIn == 0) revert InvalidAmount();
        if (amountIn > type(uint64).max) revert DepositAmountTooLarge();

        _pullFromVault(address(asset), amountIn);

        uint64 ntl = uint64(amountIn);

        L1Write.sendUpdateLeverage(perpAssetIndex, true, leverage);
        leverageSentToCore = true;
        emit LeverageUpdated(perpAssetIndex, leverage);

        L1Write.sendUsdClassTransfer(ntl, true);

        emit FundsParked(amountIn);
    }

    /// @notice Proposer-driven trading actions via precompiles
    /// @dev Decode format depends on action type:
    ///   action=1: (uint8 action, uint64 limitPx, uint64 sz, uint64 stopLossPx, uint64 stopLossSz)
    ///   action=2: (uint8 action, uint64 limitPx, uint64 sz)
    ///   action=3: (uint8 action, uint64 triggerPx, uint64 sz)
    /// @dev Notional check (#255 D-2 / S-H11): HL convention is
    ///      `szDecimals + pxDecimals = 6` for every perp asset, so
    ///      `sz * limitPx / 1e6` always yields notional in USDC-6-decimal units
    ///      regardless of the asset's specific szDecimals. This identity holds
    ///      for ALL HyperCore perps; if HL ever changes the convention, every
    ///      `approxUsd` site below must switch to per-asset divisors.
    function _updateParams(bytes calldata data) internal override {
        if (data.length < 32) revert InvalidAction();
        uint8 action = abi.decode(data[:32], (uint8));

        // Daily trade counter — every recognised action counts as a trade.
        if (action >= ACTION_OPEN_LONG) {
            if (block.timestamp / 1 days != lastTradeReset / 1 days) {
                tradesToday = 0;
                lastTradeReset = block.timestamp;
            }
            tradesToday++;
            if (tradesToday > maxTradesPerDay) revert MaxTradesExceeded();
        }

        if (action == ACTION_OPEN_LONG) {
            (, uint64 limitPx, uint64 sz, uint64 stopLossPx, uint64 stopLossSz) =
                abi.decode(data, (uint8, uint64, uint64, uint64, uint64));

            if (!leverageSentToCore) {
                L1Write.sendUpdateLeverage(perpAssetIndex, true, leverage);
                leverageSentToCore = true;
                emit LeverageUpdated(perpAssetIndex, leverage);
            }

            // On-chain position size check (approximate: sz * limitPx in 6-decimal USDC units)
            uint256 approxUsd = uint256(sz) * uint256(limitPx) / 1e6;
            if (approxUsd > maxPositionSize) revert PositionTooLarge(approxUsd, maxPositionSize);

            _cancelCurrentStopLoss();

            // Place IOC buy order (market-like)
            L1Write.sendLimitOrder(perpAssetIndex, true, limitPx, sz, false, TimeInForce.Ioc, NO_CLOID);

            // Place GTC stop loss (reduce-only sell) with fixed CLOID
            L1Write.sendLimitOrder(
                perpAssetIndex, false, stopLossPx, stopLossSz, true, TimeInForce.Gtc, STOP_LOSS_CLOID
            );
            hasActiveStopLoss = true;

            emit PositionOpened(perpAssetIndex, true, limitPx, sz, leverage);
            emit StopLossUpdated(stopLossPx);
        } else if (action == ACTION_CLOSE_POSITION) {
            (, uint64 limitPx, uint64 sz) = abi.decode(data, (uint8, uint64, uint64));

            _cancelCurrentStopLoss();

            // Place reduce-only IOC sell to close position
            L1Write.sendLimitOrder(perpAssetIndex, false, limitPx, sz, true, TimeInForce.Ioc, NO_CLOID);

            emit PositionClosed(perpAssetIndex, limitPx, sz);
        } else if (action == ACTION_UPDATE_STOP_LOSS) {
            // NOTE: action=3 is for LONG positions only (reduce-only sell).
            // For shorts, use ACTION_UPDATE_STOP_LOSS_SHORT (action=5).
            // If the wrong action is sent, HyperCore's reduce-only flag will
            // reject the order (a reduce-only sell with no long position is a no-op).
            // Position direction is NOT tracked on-chain — the proposer/agent
            // is responsible for sending the correct action type.
            (, uint64 triggerPx, uint64 sz) = abi.decode(data, (uint8, uint64, uint64));

            _cancelCurrentStopLoss();

            // Place new GTC stop loss (reduce-only sell) with fixed CLOID
            L1Write.sendLimitOrder(perpAssetIndex, false, triggerPx, sz, true, TimeInForce.Gtc, STOP_LOSS_CLOID);
            hasActiveStopLoss = true;

            emit StopLossUpdated(triggerPx);
        } else if (action == ACTION_OPEN_SHORT) {
            (, uint64 limitPx, uint64 sz, uint64 stopLossPx, uint64 stopLossSz) =
                abi.decode(data, (uint8, uint64, uint64, uint64, uint64));

            if (!leverageSentToCore) {
                L1Write.sendUpdateLeverage(perpAssetIndex, true, leverage);
                leverageSentToCore = true;
                emit LeverageUpdated(perpAssetIndex, leverage);
            }

            // On-chain position size check
            uint256 approxUsd = uint256(sz) * uint256(limitPx) / 1e6;
            if (approxUsd > maxPositionSize) revert PositionTooLarge(approxUsd, maxPositionSize);

            _cancelCurrentStopLoss();

            // Place IOC sell order (market-like short entry) - isBuy=false, reduceOnly=false
            L1Write.sendLimitOrder(perpAssetIndex, false, limitPx, sz, false, TimeInForce.Ioc, NO_CLOID);

            // Place GTC stop loss (reduce-only buy to close short) with fixed CLOID
            L1Write.sendLimitOrder(perpAssetIndex, true, stopLossPx, stopLossSz, true, TimeInForce.Gtc, STOP_LOSS_CLOID);
            hasActiveStopLoss = true;

            emit PositionOpened(perpAssetIndex, false, limitPx, sz, leverage);
            emit StopLossUpdated(stopLossPx);
        } else if (action == ACTION_UPDATE_STOP_LOSS_SHORT) {
            (, uint64 triggerPx, uint64 sz) = abi.decode(data, (uint8, uint64, uint64));

            _cancelCurrentStopLoss();

            // Place new GTC stop loss for SHORT position (reduce-only BUY) with fixed CLOID.
            // isBuy=true closes the short; triggerPx is above current price.
            L1Write.sendLimitOrder(perpAssetIndex, true, triggerPx, sz, true, TimeInForce.Gtc, STOP_LOSS_CLOID);
            hasActiveStopLoss = true;

            emit StopLossUpdated(triggerPx);
        } else if (action == ACTION_OPEN_LONG_MULTI || action == ACTION_OPEN_SHORT_MULTI) {
            // Multi-asset open: assetIndex is in the calldata, not storage.
            // Decode: (action, assetIndex, limitPx, sz, stopLossPx, stopLossSz)
            (, uint32 ai, uint64 limitPx, uint64 sz, uint64 stopLossPx, uint64 stopLossSz) =
                abi.decode(data, (uint8, uint32, uint64, uint64, uint64, uint64));

            // Set leverage on HyperCore for this asset (idempotent per asset on HyperCore)
            L1Write.sendUpdateLeverage(ai, true, leverage);

            // On-chain position size check
            uint256 approxUsd = uint256(sz) * uint256(limitPx) / 1e6;
            if (approxUsd > maxPositionSize) revert PositionTooLarge(approxUsd, maxPositionSize);

            _cancelCurrentStopLoss();

            bool isBuy = (action == ACTION_OPEN_LONG_MULTI);
            // IOC entry order
            L1Write.sendLimitOrder(ai, isBuy, limitPx, sz, false, TimeInForce.Ioc, NO_CLOID);
            // GTC stop-loss (reduce-only, opposite direction)
            L1Write.sendLimitOrder(ai, !isBuy, stopLossPx, stopLossSz, true, TimeInForce.Gtc, STOP_LOSS_CLOID);
            hasActiveStopLoss = true;

            // Track this asset for multi-asset settlement
            if (!assetTraded[ai]) {
                assetTraded[ai] = true;
                tradedAssets.push(ai);
            }
            perpAssetIndex = ai;

            emit PositionOpened(ai, isBuy, limitPx, sz, leverage);
            emit StopLossUpdated(stopLossPx);
        } else if (action == ACTION_CLOSE_MULTI) {
            // Multi-asset close: assetIndex + direction in calldata.
            // isBuy=true closes a short (buy back), isBuy=false closes a long (sell).
            // Decode: (action, assetIndex, isBuy, limitPx, sz)
            (, uint32 ai, bool isBuy, uint64 limitPx, uint64 sz) =
                abi.decode(data, (uint8, uint32, bool, uint64, uint64));

            _cancelCurrentStopLoss();

            // Reduce-only close on the specified asset and direction
            L1Write.sendLimitOrder(ai, isBuy, limitPx, sz, true, TimeInForce.Ioc, NO_CLOID);

            emit PositionClosed(ai, limitPx, sz);
        } else {
            revert InvalidAction();
        }
    }

    /// @notice Close any open position and request USD transfer from perp to spot.
    /// @dev After this call, USDC has NOT yet arrived on the EVM side.
    ///      Call sweepToVault() in a separate tx once USDC arrives.
    function _settle() internal override {
        _cancelCurrentStopLoss();

        // Close positions on ALL traded assets (not just perpAssetIndex).
        // Each asset gets both a long-close and short-close attempt — the
        // reduce-only flag makes the wrong direction a no-op on HyperCore.
        // If no multi-asset trades were made, falls back to perpAssetIndex
        // (backwards compat with legacy single-asset actions).
        if (tradedAssets.length > 0) {
            for (uint256 i = 0; i < tradedAssets.length; i++) {
                uint32 ai = tradedAssets[i];
                // Force-close LONG: sell at min price
                L1Write.sendLimitOrder(ai, false, 1, type(uint64).max, true, TimeInForce.Ioc, NO_CLOID);
                // Force-close SHORT: buy at max price
                L1Write.sendLimitOrder(ai, true, type(uint64).max, type(uint64).max, true, TimeInForce.Ioc, NO_CLOID);
            }
        } else {
            // Legacy path: only perpAssetIndex from storage
            L1Write.sendLimitOrder(perpAssetIndex, false, 1, type(uint64).max, true, TimeInForce.Ioc, NO_CLOID);
            L1Write.sendLimitOrder(
                perpAssetIndex, true, type(uint64).max, type(uint64).max, true, TimeInForce.Ioc, NO_CLOID
            );
        }

        // Transfer all USD from perp margin back to spot (async)
        L1Write.sendUsdClassTransfer(type(uint64).max, false);

        settled = true;

        emit Settled();
    }

    /// @notice Push USDC back to the vault after async transfer completes.
    /// @dev Permissionless — funds only go to the vault, no diversion possible.
    ///      Repeatable for partial async arrivals. NO minReturnAmount guard:
    ///      a strategy that loses money must still be able to return whatever
    ///      remains. The cumulative tracker (`cumulativeSwept`) records totals
    ///      for off-chain monitoring but does not gate withdrawals.
    /// @dev Closes #255 S-C6: minReturnAmount removed (was permanently locking funds on lossy strategies).
    function sweepToVault() external {
        if (!settled) revert NotSweepable();

        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal == 0) revert InvalidAmount();

        cumulativeSwept += bal;

        uint256 vaultBefore = IERC20(asset).balanceOf(vault());
        _pushAllToVault(address(asset));
        uint256 actualTransferred = IERC20(asset).balanceOf(vault()) - vaultBefore;

        emit FundsSwept(actualTransferred);
    }

    // ── L1Read-based view functions ──

    /// @notice Read the current perp position from HyperCore (source of truth).
    function getPosition() external view returns (Position memory pos) {
        return L1Read.position2(address(this), perpAssetIndex);
    }

    /// @notice Read the current USDC spot balance on HyperCore.
    function getSpotBalance() external view returns (SpotBalance memory balance) {
        return L1Read.spotBalance(address(this), 0);
    }

    /// @notice Read the account margin summary from HyperCore.
    function getMarginSummary() external view returns (AccountMarginSummary memory summary) {
        return L1Read.accountMarginSummary(0, address(this));
    }

    // ── Internal helpers ──

    /// @dev Cancel the current GTC stop-loss order if one is active.
    ///      Uses a single fixed CLOID — O(1) gas cost regardless of trade history.
    function _cancelCurrentStopLoss() internal {
        if (hasActiveStopLoss) {
            L1Write.sendCancelOrderByCloid(perpAssetIndex, STOP_LOSS_CLOID);
            hasActiveStopLoss = false;
        }
    }

    // ── positionValue ──
    // Inherits BaseStrategy's (0, false) default. A HyperEVM-native impl
    // would wrap `L1Read.accountMarginSummary(...)` and return
    // `accountValue` (clamped at zero, converted from 8-decimal USD to
    // the asset's 6-decimal USDC). Deferred until there's fork-test
    // infrastructure on HyperEVM; the existing `getMarginSummary()`
    // view is already available for any caller that wants it directly.
}
