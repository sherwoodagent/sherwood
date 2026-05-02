// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {HyperliquidGridStrategy} from "../src/strategies/HyperliquidGridStrategy.sol";
import {BaseStrategy} from "../src/strategies/BaseStrategy.sol";
import {MockCoreWriter} from "./mocks/MockCoreWriter.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {FinalizeVariant} from "../src/hyperliquid/L1Write.sol";

contract HyperliquidGridStrategyTest is Test {
    HyperliquidGridStrategy public template;
    HyperliquidGridStrategy public strategy;
    ERC20Mock public usdc;

    address public vault = makeAddr("vault");
    address public proposer = makeAddr("proposer");
    address public attacker = makeAddr("attacker");

    uint256 constant DEPOSIT = 10_000e6;
    uint32 constant LEVERAGE = 5;
    uint256 constant MAX_ORDER_SIZE = 100_000e6;
    uint32 constant MAX_ORDERS = 32;
    uint32 constant BTC_ASSET = 3;
    uint32 constant ETH_ASSET = 4;
    uint32 constant SOL_ASSET = 5;

    function setUp() public {
        usdc = new ERC20Mock("USDC", "USDC", 6);

        MockCoreWriter cw = new MockCoreWriter();
        vm.etch(0x3333333333333333333333333333333333333333, address(cw).code);

        template = new HyperliquidGridStrategy();
        address payable clone = payable(Clones.clone(address(template)));
        strategy = HyperliquidGridStrategy(clone);

        uint32[] memory assets = new uint32[](3);
        assets[0] = BTC_ASSET;
        assets[1] = ETH_ASSET;
        assets[2] = SOL_ASSET;

        bytes memory initData = abi.encode(address(usdc), DEPOSIT, LEVERAGE, MAX_ORDER_SIZE, MAX_ORDERS, assets);
        strategy.initialize(vault, proposer, initData);

        usdc.mint(vault, 100_000e6);
        vm.prank(vault);
        usdc.approve(address(strategy), type(uint256).max);
    }

    // ── Initialization ──

    function test_initialize() public view {
        assertEq(strategy.vault(), vault);
        assertEq(strategy.proposer(), proposer);
        assertEq(address(strategy.asset()), address(usdc));
        assertEq(strategy.leverage(), LEVERAGE);
        assertEq(strategy.maxOrderSize(), MAX_ORDER_SIZE);
        assertEq(strategy.maxOrdersPerTick(), MAX_ORDERS);
        assertTrue(strategy.isAssetWhitelisted(BTC_ASSET));
        assertTrue(strategy.isAssetWhitelisted(ETH_ASSET));
        assertTrue(strategy.isAssetWhitelisted(SOL_ASSET));
        assertFalse(strategy.isAssetWhitelisted(99));
    }

    function test_execute_pullsUsdcAndParksMargin() public {
        uint256 vaultBefore = usdc.balanceOf(vault);
        vm.prank(vault);
        strategy.execute();
        assertEq(usdc.balanceOf(vault), vaultBefore - DEPOSIT);
        // After _execute, USDC was transferred to strategy then sent to HyperCore via precompile.
        // The MockCoreWriter just emits the event — strategy still holds the USDC in this mock.
        assertEq(usdc.balanceOf(address(strategy)), DEPOSIT);
    }

    function _execAndPrep() internal {
        vm.prank(vault);
        strategy.execute();
    }

    function _gridOrder(uint32 ai, bool isBuy, uint64 px, uint64 sz, uint128 cloid)
        internal
        pure
        returns (HyperliquidGridStrategy.GridOrder memory)
    {
        return HyperliquidGridStrategy.GridOrder({assetIndex: ai, isBuy: isBuy, limitPx: px, sz: sz, cloid: cloid});
    }

    function test_updateParams_placeGrid_emitsOrderPlaced() public {
        _execAndPrep();
        HyperliquidGridStrategy.GridOrder[] memory orders = new HyperliquidGridStrategy.GridOrder[](2);
        orders[0] = _gridOrder(BTC_ASSET, true, 76000_000000, 100, 1);
        orders[1] = _gridOrder(BTC_ASSET, false, 78000_000000, 100, 2);
        bytes memory data = abi.encode(uint8(1), orders);

        vm.expectEmit(false, false, false, true);
        emit HyperliquidGridStrategy.GridOrderPlaced(BTC_ASSET, true, 76000_000000, 100, 1);
        vm.prank(proposer);
        strategy.updateParams(data);
    }

    function test_updateParams_placeGrid_revertsOnTooManyOrders() public {
        _execAndPrep();
        HyperliquidGridStrategy.GridOrder[] memory orders = new HyperliquidGridStrategy.GridOrder[](33);
        for (uint256 i = 0; i < 33; i++) {
            orders[i] = _gridOrder(BTC_ASSET, true, 76000_000000, 100, uint128(i));
        }
        bytes memory data = abi.encode(uint8(1), orders);
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidGridStrategy.TooManyOrders.selector, 33, 32));
        strategy.updateParams(data);
    }

    function test_updateParams_placeGrid_revertsOnUnwhitelistedAsset() public {
        _execAndPrep();
        HyperliquidGridStrategy.GridOrder[] memory orders = new HyperliquidGridStrategy.GridOrder[](1);
        orders[0] = _gridOrder(99, true, 76000_000000, 100, 1);
        bytes memory data = abi.encode(uint8(1), orders);
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidGridStrategy.AssetNotWhitelisted.selector, uint32(99)));
        strategy.updateParams(data);
    }

    function test_updateParams_cancelAll_emitsCancelled() public {
        _execAndPrep();
        uint128[] memory cloids = new uint128[](2);
        cloids[0] = 1;
        cloids[1] = 2;
        bytes memory data = abi.encode(uint8(2), BTC_ASSET, cloids);

        vm.expectEmit(false, false, false, true);
        emit HyperliquidGridStrategy.GridOrderCancelled(BTC_ASSET, 1);
        vm.prank(proposer);
        strategy.updateParams(data);
    }

    function test_updateParams_cancelAndPlace_atomicRebalance() public {
        _execAndPrep();
        uint128[] memory cloids = new uint128[](1);
        cloids[0] = 1;
        HyperliquidGridStrategy.GridOrder[] memory orders = new HyperliquidGridStrategy.GridOrder[](1);
        orders[0] = _gridOrder(BTC_ASSET, true, 77000_000000, 100, 10);
        bytes memory data = abi.encode(uint8(3), BTC_ASSET, cloids, orders);

        vm.prank(proposer);
        strategy.updateParams(data);
    }

    function test_updateParams_revertsIfNotProposer() public {
        _execAndPrep();
        HyperliquidGridStrategy.GridOrder[] memory orders = new HyperliquidGridStrategy.GridOrder[](1);
        orders[0] = _gridOrder(BTC_ASSET, true, 76000_000000, 100, 1);
        bytes memory data = abi.encode(uint8(1), orders);
        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.updateParams(data);
    }

    function test_updateParams_invalidAction_reverts() public {
        _execAndPrep();
        bytes memory data = abi.encode(uint8(99));
        vm.prank(proposer);
        vm.expectRevert(HyperliquidGridStrategy.InvalidAction.selector);
        strategy.updateParams(data);
    }

    function test_settle_marksSettled() public {
        _execAndPrep();
        vm.prank(vault);
        strategy.settle();
        assertTrue(strategy.settled());
    }

    function test_sweepToVault_pushesUsdcBack() public {
        _execAndPrep();
        vm.prank(vault);
        strategy.settle();
        // Strategy still holds DEPOSIT in mock (USD class transfer is just an event).
        uint256 vaultBefore = usdc.balanceOf(vault);
        strategy.sweepToVault();
        assertEq(usdc.balanceOf(vault), vaultBefore + DEPOSIT);
        assertGt(strategy.cumulativeSwept(), 0);
    }

    function test_sweepToVault_revertsIfNotSettled() public {
        _execAndPrep();
        vm.expectRevert(HyperliquidGridStrategy.NotSweepable.selector);
        strategy.sweepToVault();
    }

    function test_updateParams_placeGrid_revertsOnOrderTooLarge() public {
        _execAndPrep();
        HyperliquidGridStrategy.GridOrder[] memory orders = new HyperliquidGridStrategy.GridOrder[](1);
        // Order notional = sz * limitPx / 1e6. MAX_ORDER_SIZE = 100_000e6 = 1e11.
        // sz=1000, limitPx=2e14 → notional = 1000 * 2e14 / 1e6 = 2e11 (200k USD), exceeds 100k.
        orders[0] = _gridOrder(BTC_ASSET, true, 200_000_000_000_000, 1000, 1);
        bytes memory data = abi.encode(uint8(1), orders);
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(HyperliquidGridStrategy.OrderTooLarge.selector, 200_000e6, MAX_ORDER_SIZE)
        );
        strategy.updateParams(data);
    }

    // ── HyperCore finalization ──

    function test_finalizeForHyperCore_emitsAndForwardsToL1Write() public {
        assertFalse(strategy.hyperCoreFinalized());
        vm.expectEmit(true, true, true, true, address(strategy));
        emit HyperliquidGridStrategy.HyperCoreFinalized(0, FinalizeVariant.FirstStorageSlot, 0);
        vm.prank(proposer);
        strategy.finalizeForHyperCore(0, FinalizeVariant.FirstStorageSlot, 0);
        assertTrue(strategy.hyperCoreFinalized());
    }

    function test_finalizeForHyperCore_revertsIfNotProposer() public {
        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.finalizeForHyperCore(0, FinalizeVariant.FirstStorageSlot, 0);
    }

    function test_execute_selfHeals_finalizesForHyperCoreOnFirstRun() public {
        assertFalse(strategy.hyperCoreFinalized());
        vm.expectEmit(true, true, true, true, address(strategy));
        emit HyperliquidGridStrategy.HyperCoreFinalized(0, FinalizeVariant.FirstStorageSlot, 0);
        vm.prank(vault);
        strategy.execute();
        assertTrue(strategy.hyperCoreFinalized());
    }

    // ── setMaxOrdersPerTick (#272) ──

    function test_setMaxOrdersPerTick_happyPath() public {
        assertEq(strategy.maxOrdersPerTick(), MAX_ORDERS);
        vm.expectEmit(true, true, true, true, address(strategy));
        emit HyperliquidGridStrategy.MaxOrdersPerTickUpdated(MAX_ORDERS, 50);
        vm.prank(proposer);
        strategy.setMaxOrdersPerTick(50);
        assertEq(strategy.maxOrdersPerTick(), 50);
    }

    function test_setMaxOrdersPerTick_revertsOnZero() public {
        vm.prank(proposer);
        vm.expectRevert(HyperliquidGridStrategy.InvalidAmount.selector);
        strategy.setMaxOrdersPerTick(0);
    }

    function test_setMaxOrdersPerTick_revertsAboveCeiling() public {
        uint32 ceiling = strategy.MAX_ORDERS_PER_TICK_CEILING();
        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(HyperliquidGridStrategy.MaxOrdersPerTickTooLarge.selector, ceiling + 1, ceiling)
        );
        strategy.setMaxOrdersPerTick(ceiling + 1);
    }

    function test_setMaxOrdersPerTick_revertsIfNotProposer() public {
        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.setMaxOrdersPerTick(50);
    }

    function test_initialize_revertsIfMaxOrdersPerTickAboveCeiling() public {
        address payable badClone = payable(Clones.clone(address(template)));
        HyperliquidGridStrategy bad = HyperliquidGridStrategy(badClone);
        uint32 ceiling = bad.MAX_ORDERS_PER_TICK_CEILING();
        uint32[] memory assets = new uint32[](1);
        assets[0] = BTC_ASSET;
        bytes memory initData = abi.encode(address(usdc), DEPOSIT, LEVERAGE, MAX_ORDER_SIZE, ceiling + 1, assets);
        vm.expectRevert(
            abi.encodeWithSelector(HyperliquidGridStrategy.MaxOrdersPerTickTooLarge.selector, ceiling + 1, ceiling)
        );
        bad.initialize(vault, proposer, initData);
    }

    /// @notice Gas measurement at the ceiling — backs `MAX_ORDERS_PER_TICK_CEILING`
    ///         (#272 acceptance criterion #3). MockCoreWriter is cheap, so this
    ///         is a regression guard rather than a tight budget.
    function test_placeOrders_atCeiling_fitsGasBudget() public {
        uint32 ceiling = strategy.MAX_ORDERS_PER_TICK_CEILING();
        vm.prank(proposer);
        strategy.setMaxOrdersPerTick(ceiling);
        _execAndPrep();

        HyperliquidGridStrategy.GridOrder[] memory orders = new HyperliquidGridStrategy.GridOrder[](ceiling);
        for (uint256 i = 0; i < ceiling; i++) {
            orders[i] = _gridOrder(BTC_ASSET, true, 76000_000000, 100, uint128(i + 1));
        }
        bytes memory data = abi.encode(uint8(1), orders);

        vm.prank(proposer);
        uint256 gasBefore = gasleft();
        strategy.updateParams(data);
        uint256 gasUsed = gasBefore - gasleft();
        emit log_named_uint("gas used at ceiling", gasUsed);
        assertLt(gasUsed, 5_000_000);
    }

    function test_execute_skipsAutoFinalize_whenManuallyFinalized() public {
        // Proposer manually finalizes with a non-default variant first.
        vm.prank(proposer);
        strategy.finalizeForHyperCore(7, FinalizeVariant.CustomStorageSlot, 42);
        assertTrue(strategy.hyperCoreFinalized());

        // _execute should NOT emit a second HyperCoreFinalized event.
        vm.recordLogs();
        vm.prank(vault);
        strategy.execute();
        Vm.Log[] memory entries = vm.getRecordedLogs();
        bytes32 sig = keccak256("HyperCoreFinalized(uint64,uint8,uint64)");
        for (uint256 i = 0; i < entries.length; i++) {
            assertTrue(
                entries[i].topics.length == 0 || entries[i].topics[0] != sig,
                "auto-finalize fired despite manual finalize"
            );
        }
    }

    function test_sweepToVault_repeatableForPartialArrivals() public {
        _execAndPrep();
        vm.prank(vault);
        strategy.settle();
        // First sweep: full balance (DEPOSIT)
        strategy.sweepToVault();
        assertEq(strategy.cumulativeSwept(), DEPOSIT);
        // Simulate more USDC arriving from async transfer
        usdc.mint(address(strategy), 5_000e6);
        // Second sweep: should succeed without minReturn check
        uint256 vaultBefore = usdc.balanceOf(vault);
        strategy.sweepToVault();
        assertEq(usdc.balanceOf(vault), vaultBefore + 5_000e6);
    }
}
