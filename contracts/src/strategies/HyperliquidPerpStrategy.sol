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
    error InsufficientReturn(uint256 actual, uint256 minimum);
    error MaxTradesExceeded();
    error PositionTooLarge(uint256 actual, uint256 max);

    // ── Action types ──
    uint8 constant ACTION_UPDATE_MIN_RETURN = 0;
    uint8 constant ACTION_OPEN_LONG = 1;
    uint8 constant ACTION_CLOSE_POSITION = 2;
    uint8 constant ACTION_UPDATE_STOP_LOSS = 3;

    // ── CLOID constant for stop-loss tracking ──
    // Single fixed CLOID — only one GTC stop-loss is ever live at a time.
    // Each new stop-loss cancels the current one before placing a replacement.
    // Assumes HyperCore allows CLOID reuse after cancellation.
    uint128 constant STOP_LOSS_CLOID_BASE = 0x53544F504C4F53530000000000000000; // "STOPLOSS" prefix
    uint128 constant STOP_LOSS_CLOID = STOP_LOSS_CLOID_BASE + 1;

    // ── Storage (per-clone) ──
    IERC20 public asset;
    uint256 public depositAmount;
    uint256 public minReturnAmount;
    uint32 public perpAssetIndex;
    uint32 public leverage;
    bool public leverageSentToCore; // Whether leverage has been set on HyperCore
    bool public hasActiveStopLoss; // Whether a GTC stop-loss is currently live
    bool public settled; // Whether _settle() has been called
    bool public swept; // Whether sweepToVault() has been called at least once
    uint256 public maxPositionSize; // Max USDC in a single position (on-chain risk cap)
    uint32 public maxTradesPerDay; // Rate limit on trading actions per day
    uint32 public tradesToday; // Counter for today's trades
    uint256 public lastTradeReset; // Timestamp of last daily counter reset

    /// @inheritdoc IStrategy
    function name() external pure returns (string memory) {
        return "Hyperliquid Perp";
    }

    /// @notice Decode: (address asset, uint256 depositAmount, uint256 minReturnAmount, uint32 perpAssetIndex, uint32 leverage, uint256 maxPositionSize, uint32 maxTradesPerDay)
    /// @dev depositAmount_ == 0 means "use the vault's full asset balance at execute time" (dynamic-all mode).
    function _initialize(bytes calldata data) internal override {
        (
            address asset_,
            uint256 depositAmount_,
            uint256 minReturnAmount_,
            uint32 perpAssetIndex_,
            uint32 leverage_,
            uint256 maxPositionSize_,
            uint32 maxTradesPerDay_
        ) = abi.decode(data, (address, uint256, uint256, uint32, uint32, uint256, uint32));

        if (asset_ == address(0)) revert ZeroAddress();
        if (depositAmount_ > type(uint64).max) revert DepositAmountTooLarge();
        if (leverage_ == 0 || leverage_ > 50) revert InvalidAmount();
        if (maxPositionSize_ == 0) revert InvalidAmount();
        if (maxTradesPerDay_ == 0) revert InvalidAmount();

        asset = IERC20(asset_);
        depositAmount = depositAmount_;
        minReturnAmount = minReturnAmount_;
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
    ///   action=0: (uint8 action, uint256 newMinReturn)
    ///   action=1: (uint8 action, uint64 limitPx, uint64 sz, uint64 stopLossPx, uint64 stopLossSz)
    ///   action=2: (uint8 action, uint64 limitPx, uint64 sz)
    ///   action=3: (uint8 action, uint64 triggerPx, uint64 sz)
    function _updateParams(bytes calldata data) internal override {
        if (data.length < 32) revert InvalidAction();
        uint8 action = abi.decode(data[:32], (uint8));

        // Daily trade counter (actions 1/2/3 only — not action 0)
        if (action >= ACTION_OPEN_LONG) {
            if (block.timestamp / 1 days != lastTradeReset / 1 days) {
                tradesToday = 0;
                lastTradeReset = block.timestamp;
            }
            tradesToday++;
            if (tradesToday > maxTradesPerDay) revert MaxTradesExceeded();
        }

        if (action == ACTION_UPDATE_MIN_RETURN) {
            (, uint256 newMinReturn) = abi.decode(data, (uint8, uint256));
            minReturnAmount = newMinReturn;
        } else if (action == ACTION_OPEN_LONG) {
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
            (, uint64 triggerPx, uint64 sz) = abi.decode(data, (uint8, uint64, uint64));

            _cancelCurrentStopLoss();

            // Place new GTC stop loss (reduce-only sell) with fixed CLOID
            L1Write.sendLimitOrder(perpAssetIndex, false, triggerPx, sz, true, TimeInForce.Gtc, STOP_LOSS_CLOID);
            hasActiveStopLoss = true;

            emit StopLossUpdated(triggerPx);
        } else {
            revert InvalidAction();
        }
    }

    /// @notice Close any open position and request USD transfer from perp to spot.
    /// @dev After this call, USDC has NOT yet arrived on the EVM side.
    ///      Call sweepToVault() in a separate tx once USDC arrives.
    function _settle() internal override {
        // Always attempt cancel + force-close (no-op on HyperCore if no position)
        _cancelCurrentStopLoss();

        // Force-close: IOC sell at minimum price (1) to fill at any market price.
        // Reduce-only, so it's a no-op if no position exists on HyperCore.
        L1Write.sendLimitOrder(perpAssetIndex, false, 1, type(uint64).max, true, TimeInForce.Ioc, NO_CLOID);

        // Transfer all USD from perp margin back to spot (async)
        L1Write.sendUsdClassTransfer(type(uint64).max, false);

        settled = true;

        emit Settled();
    }

    /// @notice Push USDC back to the vault after async transfer completes.
    /// @dev Callable by anyone — funds only go to the vault, no griefing vector.
    ///      Can be called multiple times to handle partial async arrivals.
    ///      First call enforces minReturnAmount; subsequent calls skip the check.
    function sweepToVault() external {
        if (!settled) revert NotSweepable();

        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal == 0) revert InvalidAmount();

        // Enforce minimum return on first sweep only
        if (!swept && minReturnAmount > 0 && bal < minReturnAmount) {
            revert InsufficientReturn(bal, minReturnAmount);
        }
        swept = true;

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
