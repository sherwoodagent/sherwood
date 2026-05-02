// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseStrategy} from "./BaseStrategy.sol";
import {IStrategy} from "../interfaces/IStrategy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {L1Write, TimeInForce, NO_CLOID, FinalizeVariant} from "../hyperliquid/L1Write.sol";
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
 *
 *   HyperCore note: contract addresses (unlike EOAs) need explicit
 *   registration before bridged-token transfers auto-credit HC spot.
 *   `_execute()` self-heals on first run with safe defaults for ERC-1167
 *   clones (token = USDC, variant = FirstStorageSlot). For non-default
 *   deployments (plain CREATE, UUPS proxy, non-USDC tokens), the proposer
 *   should call `finalizeForHyperCore(...)` once before opening the
 *   proposal that triggers `_execute()`, to override the defaults.
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
    event HyperCoreFinalized(uint64 token, FinalizeVariant variant, uint64 createNonce);
    event MaxOrdersPerTickUpdated(uint32 oldValue, uint32 newValue);

    // ── Errors ──
    error InvalidAmount();
    error InvalidAction();
    error DepositAmountTooLarge();
    error NotSweepable();
    error TooManyOrders(uint256 actual, uint256 max);
    error OrderTooLarge(uint256 actual, uint256 max);
    error AssetNotWhitelisted(uint32 asset);
    error MaxOrdersPerTickTooLarge(uint32 actual, uint32 max);

    // ── Action types ──
    uint8 constant ACTION_PLACE_GRID = 1;
    uint8 constant ACTION_CANCEL_ALL = 2;
    uint8 constant ACTION_CANCEL_AND_PLACE = 3;

    // ── Limits ──
    uint32 constant MAX_ASSETS = 32;
    /// @notice Hard ceiling on `maxOrdersPerTick` to bound the gas of a single
    ///         `_placeOrders` loop. Each order issues an L1Write precompile
    ///         call (~50k gas including encoding + emit), so 64 ≈ 3.2M gas
    ///         worst-case for the loop alone — well under HyperEVM's block
    ///         gas limit and leaves headroom for cancel-and-place hybrids.
    uint32 public constant MAX_ORDERS_PER_TICK_CEILING = 64;

    // ── Storage (per-clone) ──
    IERC20 public asset;
    uint256 public depositAmount;
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
    /// @notice True once this contract has been registered with HyperCore so
    ///         bridged-token transfers auto-credit HC spot. Set by either the
    ///         explicit `finalizeForHyperCore` proposer call, or the implicit
    ///         self-heal in `_execute()` on first run.
    bool public hyperCoreFinalized;

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
            uint32 leverage_,
            uint256 maxOrderSize_,
            uint32 maxOrdersPerTick_,
            uint32[] memory assetIndices_
        ) = abi.decode(data, (address, uint256, uint32, uint256, uint32, uint32[]));

        if (asset_ == address(0)) revert ZeroAddress();
        if (depositAmount_ > type(uint64).max) revert DepositAmountTooLarge();
        if (leverage_ == 0 || leverage_ > 50) revert InvalidAmount();
        if (maxOrderSize_ == 0) revert InvalidAmount();
        if (maxOrdersPerTick_ == 0) revert InvalidAmount();
        if (maxOrdersPerTick_ > MAX_ORDERS_PER_TICK_CEILING) {
            revert MaxOrdersPerTickTooLarge(maxOrdersPerTick_, MAX_ORDERS_PER_TICK_CEILING);
        }
        if (assetIndices_.length == 0) revert InvalidAmount();
        if (assetIndices_.length > MAX_ASSETS) revert InvalidAmount();

        asset = IERC20(asset_);
        depositAmount = depositAmount_;
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

    /**
     * @notice Override the default HyperCore finalization with non-default
     *         variant/token/createNonce. **Optional** — `_execute()` will
     *         self-heal on first run using safe defaults
     *         (`token=0`, `FirstStorageSlot`, `createNonce=0`) suitable for
     *         the canonical SyndicateFactory ERC-1167 clone case.
     *
     *         Call this BEFORE the proposal that triggers `_execute()` only
     *         if the deployment method differs from the default (e.g. plain
     *         CREATE or a custom storage layout) or if a non-USDC token
     *         needs to be finalized.
     *
     * @param token        HyperCore token index (USDC = 0).
     * @param variant      Deployment-method variant:
     *                       Create (1)            — contract deployed via plain CREATE
     *                       FirstStorageSlot (2)  — typical ERC-1167 clone (default)
     *                       CustomStorageSlot (3) — UUPS / custom proxy
     * @param createNonce  Deployer nonce when the contract was created
     *                     (only consulted for the Create variant; pass 0 otherwise).
     */
    function finalizeForHyperCore(uint64 token, FinalizeVariant variant, uint64 createNonce) external onlyProposer {
        L1Write.sendFinalizeEvmContract(token, variant, createNonce);
        hyperCoreFinalized = true;
        emit HyperCoreFinalized(token, variant, createNonce);
    }

    /**
     * @notice Update `maxOrdersPerTick` after deployment. Lets the proposer
     *         raise the per-call cap once they're confident in the keeper's
     *         batching, or lower it as a defensive measure. The keeper's
     *         off-chain chunker reads this value at startup and adapts —
     *         older clones that need chunking keep working unchanged
     *         (closes #272).
     *
     *         Bound to `MAX_ORDERS_PER_TICK_CEILING` so a malicious or buggy
     *         setter call can't push the per-tick gas of `_placeOrders`
     *         above the block limit. Per-order size cap (`maxOrderSize`) is
     *         a separate axis and stays unaffected.
     *
     * @param newValue New per-tick order cap. Must be in (0, ceiling].
     */
    function setMaxOrdersPerTick(uint32 newValue) external onlyProposer {
        if (newValue == 0) revert InvalidAmount();
        if (newValue > MAX_ORDERS_PER_TICK_CEILING) {
            revert MaxOrdersPerTickTooLarge(newValue, MAX_ORDERS_PER_TICK_CEILING);
        }
        emit MaxOrdersPerTickUpdated(maxOrdersPerTick, newValue);
        maxOrdersPerTick = newValue;
    }

    function _execute() internal override {
        uint256 amountIn = depositAmount;
        if (amountIn == 0) {
            amountIn = IERC20(asset).balanceOf(vault());
        }
        if (amountIn == 0) revert InvalidAmount();
        if (amountIn > type(uint64).max) revert DepositAmountTooLarge();

        // Self-heal: if the proposer didn't call finalizeForHyperCore manually
        // with a non-default variant, register this contract with HyperCore
        // using safe defaults (USDC = token 0, FirstStorageSlot for ERC-1167
        // clones). Without this, the ERC20 transfer below lands on HyperEVM
        // only and `sendUsdClassTransfer` runs against zero HC spot balance.
        if (!hyperCoreFinalized) {
            L1Write.sendFinalizeEvmContract(0, FinalizeVariant.FirstStorageSlot, 0);
            hyperCoreFinalized = true;
            emit HyperCoreFinalized(0, FinalizeVariant.FirstStorageSlot, 0);
        }

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
