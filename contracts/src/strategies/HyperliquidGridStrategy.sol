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
    error PositionTooLarge(uint256 actual, uint256 max);
    error AssetNotWhitelisted(uint32 asset);

    // ── Action types ──
    uint8 constant ACTION_PLACE_GRID = 1;
    uint8 constant ACTION_CANCEL_ALL = 2;
    uint8 constant ACTION_CANCEL_AND_PLACE = 3;

    // ── Storage (per-clone) ──
    IERC20 public asset;
    uint256 public depositAmount;
    uint256 public minReturnAmount;
    uint32 public leverage;
    uint256 public maxPositionSize;
    uint32 public maxOrdersPerTick;
    uint32[] public assetIndices;
    mapping(uint32 => bool) public isAssetWhitelisted;
    bool public settled;
    bool public swept;

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
            uint256 maxPositionSize_,
            uint32 maxOrdersPerTick_,
            uint32[] memory assetIndices_
        ) = abi.decode(data, (address, uint256, uint256, uint32, uint256, uint32, uint32[]));

        if (asset_ == address(0)) revert ZeroAddress();
        if (depositAmount_ > type(uint64).max) revert DepositAmountTooLarge();
        if (leverage_ == 0 || leverage_ > 50) revert InvalidAmount();
        if (maxPositionSize_ == 0) revert InvalidAmount();
        if (maxOrdersPerTick_ == 0) revert InvalidAmount();
        if (assetIndices_.length == 0) revert InvalidAmount();

        asset = IERC20(asset_);
        depositAmount = depositAmount_;
        minReturnAmount = minReturnAmount_;
        leverage = leverage_;
        maxPositionSize = maxPositionSize_;
        maxOrdersPerTick = maxOrdersPerTick_;
        for (uint256 i = 0; i < assetIndices_.length; i++) {
            assetIndices.push(assetIndices_[i]);
            isAssetWhitelisted[assetIndices_[i]] = true;
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

    function _placeOrders(GridOrder[] memory orders) internal {
        if (orders.length > maxOrdersPerTick) revert TooManyOrders(orders.length, maxOrdersPerTick);
        for (uint256 i = 0; i < orders.length; i++) {
            GridOrder memory o = orders[i];
            if (!isAssetWhitelisted[o.assetIndex]) revert AssetNotWhitelisted(o.assetIndex);
            uint256 approxUsd = uint256(o.sz) * uint256(o.limitPx) / 1e6;
            if (approxUsd > maxPositionSize) revert PositionTooLarge(approxUsd, maxPositionSize);
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
