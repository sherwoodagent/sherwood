// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategy} from "../interfaces/IStrategy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {L1Write, TimeInForce, NO_CLOID} from "../hyperliquid/L1Write.sol";
import {L1Read, Position, SpotBalance, AccountMarginSummary} from "../hyperliquid/L1Read.sol";

/**
 * @title HyperliquidGridStrategy
 * @notice On-chain grid trading strategy using HyperEVM precompiles.
 *
 *   USDC is pulled from the vault and parked on HyperCore margin via
 *   L1Write.sendUsdClassTransfer(). The proposer (keeper EOA) drives
 *   the grid by calling updateParams() every 60s with batch orders.
 *
 *   Action types:
 *     - ACTION_PLACE_GRID: place batch of GTC limit orders
 *     - ACTION_CANCEL_ALL: cancel all open orders for an asset (CLOIDs in calldata)
 *     - ACTION_CANCEL_AND_PLACE: atomic cancel + place (rebalance)
 *
 *   Settlement: _settle() force-closes all positions on tracked assets +
 *   requests async USD transfer back to spot. sweepToVault() pushes USDC
 *   back to the vault when it arrives.
 */
contract HyperliquidGridStrategy is BaseStrategy {
    using SafeERC20 for IERC20;

    // ── Events ──
    event GridOrderPlaced(uint32 asset, bool isBuy, uint64 limitPx, uint64 sz, uint128 cloid);
    event GridOrderCancelled(uint32 asset, uint128 cloid);
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
    error TooManyOrders(uint256 actual, uint256 max);
    error OrderTooLarge(uint256 actual, uint256 max);
    error AssetNotWhitelisted(uint32 asset);

    // ── Action types ──
    uint8 constant ACTION_PLACE_GRID = 1;
    uint8 constant ACTION_CANCEL_ALL = 2;
    uint8 constant ACTION_CANCEL_AND_PLACE = 3;

    // ── Limits ──
    uint32 constant MAX_ASSETS = 32;

    // ── Storage (per-clone) ──
    IERC20 public asset;
    uint256 public depositAmount;
    uint256 public minReturnAmount;
    uint32 public leverage;
    /// @notice Per-order notional cap (USD, 6 decimals). Each individual GridOrder's
    ///         notional (sz * limitPx / 1e6) must be <= this value. This is NOT a
    ///         cumulative per-asset exposure cap — the keeper is trusted to compose
    ///         grids correctly. Per-order bound limits blast radius of a single bad
    ///         order (typo, fat-finger, compromised keeper) without constraining
    ///         legitimate grid layouts.
    uint256 public maxOrderSize;
    uint32 public maxOrdersPerTick;
    uint32[] public assetIndices;
    mapping(uint32 => bool) public isAssetWhitelisted;
    bool public settled;
    uint256 public cumulativeSwept;

    struct GridOrder {
        uint32 assetIndex;
        bool isBuy;
        uint64 limitPx;
        uint64 sz;
        uint128 cloid;
    }

    /// @inheritdoc IStrategy
    function name() external pure returns (string memory) {
        return "Hyperliquid Grid";
    }

    function _initialize(bytes calldata data) internal override {
        (
            address asset_,
            uint256 depositAmount_,
            uint256 minReturnAmount_,
            uint32 leverage_,
            uint256 maxOrderSize_,
            uint32 maxOrdersPerTick_,
            uint32[] memory assetIndices_
        ) = abi.decode(data, (address, uint256, uint256, uint32, uint256, uint32, uint32[]));

        if (asset_ == address(0)) revert ZeroAddress();
        if (depositAmount_ > type(uint64).max) revert DepositAmountTooLarge();
        if (leverage_ == 0 || leverage_ > 50) revert InvalidAmount();
        if (maxOrderSize_ == 0) revert InvalidAmount();
        if (maxOrdersPerTick_ == 0) revert InvalidAmount();
        if (assetIndices_.length == 0) revert InvalidAmount();
        if (assetIndices_.length > MAX_ASSETS) revert InvalidAmount();

        asset = IERC20(asset_);
        depositAmount = depositAmount_;
        minReturnAmount = minReturnAmount_;
        leverage = leverage_;
        maxOrderSize = maxOrderSize_;
        maxOrdersPerTick = maxOrdersPerTick_;
        for (uint256 i = 0; i < assetIndices_.length; i++) {
            uint32 ai = assetIndices_[i];
            if (isAssetWhitelisted[ai]) continue; // dedup
            assetIndices.push(ai);
            isAssetWhitelisted[ai] = true;
        }
    }

    function _execute() internal override {
        uint256 amountIn = depositAmount;
        if (amountIn == 0) {
            amountIn = IERC20(asset).balanceOf(vault());
        }
        if (amountIn == 0) revert InvalidAmount();
        if (amountIn > type(uint64).max) revert DepositAmountTooLarge();

        _pullFromVault(address(asset), amountIn);

        uint64 ntl = uint64(amountIn);

        for (uint256 i = 0; i < assetIndices.length; i++) {
            L1Write.sendUpdateLeverage(assetIndices[i], true, leverage);
            emit LeverageUpdated(assetIndices[i], leverage);
        }

        L1Write.sendUsdClassTransfer(ntl, true);

        emit FundsParked(amountIn);
    }

    function _updateParams(bytes calldata data) internal override {
        if (data.length < 32) revert InvalidAction();
        uint8 action = abi.decode(data[:32], (uint8));

        if (action == ACTION_PLACE_GRID) {
            (, GridOrder[] memory orders) = abi.decode(data, (uint8, GridOrder[]));
            _placeOrders(orders);
        } else if (action == ACTION_CANCEL_ALL) {
            (, uint32 assetIndex, uint128[] memory cloids) = abi.decode(data, (uint8, uint32, uint128[]));
            _cancelOrders(assetIndex, cloids);
        } else if (action == ACTION_CANCEL_AND_PLACE) {
            (, uint32 assetIndex, uint128[] memory cloids, GridOrder[] memory orders) =
                abi.decode(data, (uint8, uint32, uint128[], GridOrder[]));
            _cancelOrders(assetIndex, cloids);
            _placeOrders(orders);
        } else {
            revert InvalidAction();
        }
    }

    /// @dev Notional check: HL convention is `szDecimals + pxDecimals = 6`, so
    ///      `sz * limitPx / 1e6` always yields notional in USDC-6-decimal units
    ///      regardless of the asset's specific szDecimals. This holds for ALL
    ///      perps on HyperCore.
    function _placeOrders(GridOrder[] memory orders) internal {
        if (orders.length > maxOrdersPerTick) revert TooManyOrders(orders.length, maxOrdersPerTick);
        for (uint256 i = 0; i < orders.length; i++) {
            GridOrder memory o = orders[i];
            if (!isAssetWhitelisted[o.assetIndex]) revert AssetNotWhitelisted(o.assetIndex);
            uint256 approxUsd = uint256(o.sz) * uint256(o.limitPx) / 1e6;
            if (approxUsd > maxOrderSize) revert OrderTooLarge(approxUsd, maxOrderSize);
            L1Write.sendLimitOrder(o.assetIndex, o.isBuy, o.limitPx, o.sz, false, TimeInForce.Gtc, o.cloid);
            emit GridOrderPlaced(o.assetIndex, o.isBuy, o.limitPx, o.sz, o.cloid);
        }
    }

    function _cancelOrders(uint32 assetIndex, uint128[] memory cloids) internal {
        if (!isAssetWhitelisted[assetIndex]) revert AssetNotWhitelisted(assetIndex);
        for (uint256 i = 0; i < cloids.length; i++) {
            L1Write.sendCancelOrderByCloid(assetIndex, cloids[i]);
            emit GridOrderCancelled(assetIndex, cloids[i]);
        }
    }

    /// @notice Force-close all positions on tracked assets, transfer USD back to spot.
    /// @dev IMPORTANT — SETTLEMENT RUNBOOK:
    ///      Before the vault calls this (via the governor's settle action), the
    ///      keeper MUST call `updateParams(ACTION_CANCEL_ALL)` for each asset to
    ///      cancel all resting GTC grid orders. Otherwise resting orders may
    ///      fill against the IOC reduce-only force-close orders here, leaving
    ///      net positions and stranded margin. The contract cannot self-cancel
    ///      because it does not store CLOIDs (keeper provides them per-call).
    /// @dev USDC arrives async — call sweepToVault() in a separate tx after arrival.
    function _settle() internal override {
        for (uint256 i = 0; i < assetIndices.length; i++) {
            uint32 ai = assetIndices[i];
            // Force-close LONG: reduce-only sell at min price
            L1Write.sendLimitOrder(ai, false, 1, type(uint64).max, true, TimeInForce.Ioc, NO_CLOID);
            // Force-close SHORT: reduce-only buy at max price
            L1Write.sendLimitOrder(ai, true, type(uint64).max, type(uint64).max, true, TimeInForce.Ioc, NO_CLOID);
        }

        L1Write.sendUsdClassTransfer(type(uint64).max, false);
        settled = true;
        emit Settled();
    }

    /// @notice Push USDC back to the vault after async transfer completes.
    /// @dev Permissionless — funds only go to vault. Repeatable for partial arrivals.
    function sweepToVault() external {
        if (!settled) revert NotSweepable();

        uint256 bal = IERC20(asset).balanceOf(address(this));
        if (bal == 0) revert InvalidAmount();

        // Enforce minReturn cumulatively until threshold met. Prevents dust race
        // where an attacker triggers the first sweep with 1 USDC of arrived
        // funds and bypasses the LP minReturn guarantee for subsequent arrivals.
        uint256 newTotal = cumulativeSwept + bal;
        if (minReturnAmount > 0 && newTotal < minReturnAmount) {
            revert InsufficientReturn(newTotal, minReturnAmount);
        }
        cumulativeSwept = newTotal;

        uint256 vaultBefore = IERC20(asset).balanceOf(vault());
        _pushAllToVault(address(asset));
        uint256 actualTransferred = IERC20(asset).balanceOf(vault()) - vaultBefore;

        emit FundsSwept(actualTransferred);
    }

    // ── L1Read-based view functions ──

    function getPosition(uint32 ai) external view returns (Position memory) {
        return L1Read.position2(address(this), ai);
    }

    function getSpotBalance() external view returns (SpotBalance memory) {
        return L1Read.spotBalance(address(this), 0);
    }

    function getMarginSummary() external view returns (AccountMarginSummary memory) {
        return L1Read.accountMarginSummary(0, address(this));
    }
}
