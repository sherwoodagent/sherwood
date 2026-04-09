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
 *   On settlement, any open position is closed and funds are returned
 *   to the vault via a 2-phase settle process (C1).
 *
 *   NO off-chain keeper — all actions go through HyperCore precompiles.
 *
 *   Settlement is 2-phase because sendUsdClassTransfer is async (event-based):
 *     Phase 1 (_settle): Close position + request USD transfer from perp to spot.
 *     Phase 2 (sweepToVault): Called separately after USDC arrives on EVM side,
 *             pushes all USDC back to the vault.
 */
contract HyperliquidPerpStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ── Events ──
    event PositionOpened(uint32 asset, bool isBuy, uint64 limitPx, uint64 sz, uint32 leverage);
    event PositionClosed(uint32 asset, uint64 limitPx, uint64 sz);
    event StopLossUpdated(uint64 triggerPx);
    event FundsParked(uint256 amount);
    event SettlePhase1Complete();
    event SettlePhase2Complete(uint256 amountReturned);
    event LeverageUpdated(uint32 asset, uint32 leverage);

    // ── Errors ──
    error InvalidAmount();
    error InvalidAction();
    error NoOpenPosition();
    error DepositAmountTooLarge();
    error NotSweepable();
    error InsufficientReturn(uint256 actual, uint256 minimum);
    error CloidNonceExhausted();

    // ── Action types ──
    uint8 constant ACTION_UPDATE_MIN_RETURN = 0;
    uint8 constant ACTION_OPEN_LONG = 1;
    uint8 constant ACTION_CLOSE_POSITION = 2;
    uint8 constant ACTION_UPDATE_STOP_LOSS = 3;

    // ── Settlement phase tracking (C1) ──
    enum SettlePhase {
        NONE, // Not settling
        CLOSING, // Phase 1 done: position closed, USD transfer requested, waiting for USDC
        SWEEPING // Phase 2 done: funds pushed to vault (terminal)
    }

    // ── CLOID constants for order tracking (C2) ──
    // We use deterministic CLOIDs so we can cancel by CLOID instead of relying on OIDs.
    // Stop-loss orders use a fixed CLOID pattern based on a counter.
    uint128 constant STOP_LOSS_CLOID_BASE = 0x53544F504C4F53530000000000000000; // "STOPLOSS" prefix
    uint64 constant MAX_CLOID_NONCE = 200; // Hard cap to prevent gas DoS on cancel loops

    // ── Storage (per-clone) ──
    IERC20 public asset;
    uint256 public depositAmount;
    uint256 public minReturnAmount;
    uint32 public perpAssetIndex;
    uint32 public leverage;

    /// @notice Whether a perp position is currently open on the EVM side.
    /// @dev WARNING: This flag can desync from actual HyperCore position state.
    ///      - If a GTC stop-loss order fills on HyperCore, the position closes there
    ///        but positionOpen remains true on-chain until ACTION_CLOSE_POSITION is called.
    ///      - If an IOC buy order in ACTION_OPEN_LONG does not fill (insufficient liquidity),
    ///        positionOpen is set to true even though no position exists on HyperCore.
    ///      The proposer MUST read L1Read.position2() before acting to confirm actual state.
    bool public positionOpen;
    SettlePhase public settlePhase;
    uint64 public stopLossCloidNonce; // Incrementing nonce for stop-loss CLOIDs (C2)
    bool public leverageSentToCore; // Whether leverage has been set on HyperCore (H1)
    uint256 public settleTimestamp; // When _settle() was called (for vault fallback sweep)

    /// @inheritdoc IStrategy
    function name() external pure returns (string memory) {
        return "Hyperliquid Perp";
    }

    /// @notice Decode: (address asset, uint256 depositAmount, uint256 minReturnAmount, uint32 perpAssetIndex, uint32 leverage)
    function _initialize(bytes calldata data) internal override {
        (address asset_, uint256 depositAmount_, uint256 minReturnAmount_, uint32 perpAssetIndex_, uint32 leverage_) =
            abi.decode(data, (address, uint256, uint256, uint32, uint32));

        if (asset_ == address(0)) revert ZeroAddress();
        if (depositAmount_ == 0) revert InvalidAmount();
        // C3: Prevent silent truncation when casting to uint64
        if (depositAmount_ > type(uint64).max) revert DepositAmountTooLarge();
        // Validate leverage bounds (Hyperliquid supports 1x–50x)
        if (leverage_ == 0 || leverage_ > 50) revert InvalidAmount();

        asset = IERC20(asset_);
        depositAmount = depositAmount_;
        minReturnAmount = minReturnAmount_;
        perpAssetIndex = perpAssetIndex_;
        leverage = leverage_;
    }

    /// @notice Pull USDC from vault, transfer to perp margin via precompile
    function _execute() internal override {
        _pullFromVault(address(asset), depositAmount);

        // C3: Safe cast — validated in _initialize that depositAmount <= type(uint64).max
        uint64 ntl = uint64(depositAmount);

        // H1: Set leverage on HyperCore before any trading
        L1Write.sendUpdateLeverage(perpAssetIndex, true, leverage);
        leverageSentToCore = true;
        emit LeverageUpdated(perpAssetIndex, leverage);

        // Transfer USDC to perp margin via HyperCore precompile
        // Amount is in raw HyperCore units (6 decimals for USDC)
        L1Write.sendUsdClassTransfer(ntl, true);

        emit FundsParked(depositAmount);
    }

    /// @notice Proposer-driven trading actions via precompiles
    /// @dev Decode format depends on action type:
    ///   action=0: (uint8 action, uint256 newMinReturn)
    ///   action=1: (uint8 action, uint64 limitPx, uint64 sz, uint64 stopLossPx, uint64 stopLossSz)
    ///   action=2: (uint8 action, uint64 limitPx, uint64 sz)
    ///   action=3: (uint8 action, uint64 triggerPx, uint64 sz)
    function _updateParams(bytes calldata data) internal override {
        if (data.length < 32) revert InvalidAction();
        // Action byte is the first ABI-encoded uint8 (padded to 32 bytes)
        uint8 action = abi.decode(data[:32], (uint8));

        if (action == ACTION_UPDATE_MIN_RETURN) {
            (, uint256 newMinReturn) = abi.decode(data, (uint8, uint256));
            minReturnAmount = newMinReturn;
        } else if (action == ACTION_OPEN_LONG) {
            (, uint64 limitPx, uint64 sz, uint64 stopLossPx, uint64 stopLossSz) =
                abi.decode(data, (uint8, uint64, uint64, uint64, uint64));

            // H1: Ensure leverage is set on HyperCore (in case execute didn't run yet on core)
            if (!leverageSentToCore) {
                L1Write.sendUpdateLeverage(perpAssetIndex, true, leverage);
                leverageSentToCore = true;
                emit LeverageUpdated(perpAssetIndex, leverage);
            }

            // C2: Cancel ALL existing orders for this asset before placing new ones
            // This replaces the broken OID-based cancellation
            _cancelAllOrdersForAsset();

            // Place IOC buy order (market-like)
            L1Write.sendLimitOrder(
                perpAssetIndex,
                true, // isBuy
                limitPx,
                sz,
                false, // not reduceOnly
                TimeInForce.Ioc,
                NO_CLOID
            );

            // Place GTC stop loss order (reduce-only sell) with tracked CLOID
            uint128 slCloid = _nextStopLossCloid();
            L1Write.sendLimitOrder(
                perpAssetIndex,
                false, // isSell
                stopLossPx,
                stopLossSz,
                true, // reduceOnly
                TimeInForce.Gtc,
                slCloid
            );

            positionOpen = true;

            emit PositionOpened(perpAssetIndex, true, limitPx, sz, leverage);
            emit StopLossUpdated(stopLossPx);
        } else if (action == ACTION_CLOSE_POSITION) {
            if (!positionOpen) revert NoOpenPosition();

            (, uint64 limitPx, uint64 sz) = abi.decode(data, (uint8, uint64, uint64));

            // C2: Cancel ALL orders for this asset (replaces broken OID-based stop-loss cancel)
            _cancelAllOrdersForAsset();

            // Place reduce-only IOC sell to close position
            L1Write.sendLimitOrder(
                perpAssetIndex,
                false, // isSell
                limitPx,
                sz,
                true, // reduceOnly
                TimeInForce.Ioc,
                NO_CLOID
            );

            positionOpen = false;

            emit PositionClosed(perpAssetIndex, limitPx, sz);
        } else if (action == ACTION_UPDATE_STOP_LOSS) {
            if (!positionOpen) revert NoOpenPosition();

            (, uint64 triggerPx, uint64 sz) = abi.decode(data, (uint8, uint64, uint64));

            // C2: Cancel ALL orders then place new stop-loss (replaces broken OID cancel)
            _cancelAllOrdersForAsset();

            // Place new GTC stop loss (reduce-only sell) with tracked CLOID
            uint128 slCloid = _nextStopLossCloid();
            L1Write.sendLimitOrder(
                perpAssetIndex,
                false, // isSell
                triggerPx,
                sz,
                true, // reduceOnly
                TimeInForce.Gtc,
                slCloid
            );

            emit StopLossUpdated(triggerPx);
        } else {
            revert InvalidAction();
        }
    }

    /// @notice Phase 1: Close any open position and request USD transfer from perp to spot.
    /// @dev After this call, USDC has NOT yet arrived on the EVM side.
    ///      The vault/proposer must call sweepToVault() in a separate tx once USDC arrives.
    function _settle() internal override {
        // If position is still open, force close
        if (positionOpen) {
            // C2: Cancel ALL orders first (stop-losses, etc.)
            _cancelAllOrdersForAsset();

            // Force-close: IOC sell at minimum price (1) to fill at any market price.
            // Using 1 instead of 0 because HyperCore may reject zero-price orders.
            L1Write.sendLimitOrder(
                perpAssetIndex,
                false, // isSell
                1, // minimum valid price — IOC will fill at best available
                type(uint64).max, // max size to close full position
                true, // reduceOnly
                TimeInForce.Ioc,
                NO_CLOID
            );

            positionOpen = false;
        }

        // Transfer USD from perp margin back to spot
        // H4: type(uint64).max is used as a sentinel to sweep all available margin.
        // This is the standard HyperCore pattern for "transfer everything".
        L1Write.sendUsdClassTransfer(type(uint64).max, false);

        // C1: Mark as phase 1 complete — do NOT push to vault yet.
        // USDC transfer is async (event-based) and hasn't arrived.
        settlePhase = SettlePhase.CLOSING;
        settleTimestamp = block.timestamp;

        emit SettlePhase1Complete();
    }

    /// @notice Phase 2: Push all USDC back to the vault.
    /// @dev Must be called in a separate transaction after _settle(), once USDC
    ///      has arrived on the EVM side from the async L1Write transfer.
    ///      Proposer can call immediately. After 24 hours, the vault itself can call
    ///      as a fallback to prevent permanent fund lock if the proposer is unresponsive.
    function sweepToVault() external {
        // C1: Only callable after phase 1 (CLOSING)
        if (settlePhase != SettlePhase.CLOSING) revert NotSweepable();

        // Access: proposer immediately, vault after 24h grace period
        bool isProposer = msg.sender == this.proposer();
        bool isVaultFallback = msg.sender == vault() && block.timestamp >= settleTimestamp + 24 hours;
        if (!isProposer && !isVaultFallback) revert NotProposer();

        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal == 0) revert InvalidAmount();
        if (minReturnAmount > 0 && bal < minReturnAmount) revert InsufficientReturn(bal, minReturnAmount);

        settlePhase = SettlePhase.SWEEPING;

        uint256 vaultBefore = IERC20(asset).balanceOf(vault());
        _pushAllToVault(address(asset));
        uint256 actualTransferred = IERC20(asset).balanceOf(vault()) - vaultBefore;

        emit SettlePhase2Complete(actualTransferred);
    }

    // ── H3: L1Read-based view functions ──

    /// @notice Read the current perp position from HyperCore via L1Read precompiles.
    /// @dev Allows the proposer to check position state before acting.
    /// @return pos The current position (szi, entryNtl, isolatedRawUsd, leverage, isIsolated)
    function getPosition() external view returns (Position memory pos) {
        return L1Read.position2(address(this), perpAssetIndex);
    }

    /// @notice Read the current USDC spot balance on HyperCore.
    /// @return balance The spot balance (total, hold, entryNtl)
    function getSpotBalance() external view returns (SpotBalance memory balance) {
        // Token index 0 is USDC on HyperCore
        return L1Read.spotBalance(address(this), 0);
    }

    /// @notice Read the account margin summary from HyperCore.
    /// @return summary The margin summary (accountValue, marginUsed, ntlPos, rawUsd)
    function getMarginSummary() external view returns (AccountMarginSummary memory summary) {
        // Perp dex index 0 is the main perp dex
        return L1Read.accountMarginSummary(0, address(this));
    }

    // ── Internal helpers ──

    /// @dev Cancel the current stop-loss GTC order by its CLOID.
    ///      Only GTC orders persist (IOC auto-expire), and only one stop-loss is live at
    ///      a time — each new ACTION_OPEN_LONG or ACTION_UPDATE_STOP_LOSS cancels the
    ///      current one before placing a new one. We cancel only the latest CLOID to keep
    ///      gas cost O(1) and avoid block-gas-limit DoS on settlement.
    function _cancelAllOrdersForAsset() internal {
        if (stopLossCloidNonce > 0) {
            uint128 currentCloid = STOP_LOSS_CLOID_BASE + uint128(stopLossCloidNonce);
            L1Write.sendCancelOrderByCloid(perpAssetIndex, currentCloid);
        }
    }

    /// @dev Generate the next stop-loss CLOID and increment the nonce.
    ///      Capped at MAX_CLOID_NONCE to prevent unbounded nonce growth.
    function _nextStopLossCloid() internal returns (uint128) {
        if (stopLossCloidNonce >= MAX_CLOID_NONCE) revert CloidNonceExhausted();
        stopLossCloidNonce++;
        return STOP_LOSS_CLOID_BASE + uint128(stopLossCloidNonce);
    }
}
