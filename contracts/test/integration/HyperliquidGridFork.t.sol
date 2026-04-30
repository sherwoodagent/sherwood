// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HyperEVMIntegrationTest} from "./HyperEVMIntegrationTest.sol";
import {HyperliquidGridStrategy} from "../../src/strategies/HyperliquidGridStrategy.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Vm} from "forge-std/Vm.sol";

/**
 * @title HyperliquidGridFork
 * @notice Full syndicate lifecycle on a HyperEVM mainnet fork using the real
 *         CoreWriter precompile (events emit on the fork — HyperCore can't
 *         process them, so USDC stays in the strategy and `sweepToVault()`
 *         returns it to the vault).
 */
contract HyperliquidGridForkTest is HyperEVMIntegrationTest {
    uint256 constant DEPOSIT = 50_000e6;
    uint32 constant LEVERAGE = 5;
    uint256 constant MAX_ORDER_SIZE = 10_000e6;
    uint32 constant MAX_ORDERS = 32;
    uint256 constant DURATION = 7 days;

    function setUp() public override {
        super.setUp();
        // If the parent skipped (no fork URL), bail out before any chain interaction.
        if (address(factory) == address(0)) return;
        vault = _createSyndicate();
        _fundAndDeposit(vault, 60_000e6, 40_000e6);
        vm.warp(block.timestamp + 1); // snapshot block in the past for voting
    }

    function _initData() internal pure returns (bytes memory) {
        uint32[] memory assets = new uint32[](3);
        assets[0] = HL_BTC;
        assets[1] = HL_ETH;
        assets[2] = HL_SOL;
        return abi.encode(USDC, DEPOSIT, LEVERAGE, MAX_ORDER_SIZE, MAX_ORDERS, assets);
    }

    function _execAndSettleCalls(address clone)
        internal
        pure
        returns (BatchExecutorLib.Call[] memory exec, BatchExecutorLib.Call[] memory settle)
    {
        exec = new BatchExecutorLib.Call[](2);
        exec[0] =
            BatchExecutorLib.Call({target: USDC, data: abi.encodeCall(IERC20.approve, (clone, DEPOSIT)), value: 0});
        exec[1] = BatchExecutorLib.Call({target: clone, data: abi.encodeWithSignature("execute()"), value: 0});

        settle = new BatchExecutorLib.Call[](1);
        settle[0] = BatchExecutorLib.Call({target: clone, data: abi.encodeWithSignature("settle()"), value: 0});
    }

    function test_fullLifecycle_placeGridAndSettle() public {
        // 1. Clone + init strategy
        address clone = _cloneAndInit(hyperliquidGridTemplate, _initData());
        HyperliquidGridStrategy strategy = HyperliquidGridStrategy(clone);

        // 2. Build proposal calls
        (BatchExecutorLib.Call[] memory exec, BatchExecutorLib.Call[] memory settle) = _execAndSettleCalls(clone);

        // 3. Propose, vote, advance to executable, execute
        uint256 vaultBalanceBefore = IERC20(USDC).balanceOf(address(vault));
        uint256 proposalId = _proposeVoteApprove(exec, settle, 1000, DURATION);

        // 4. Verify execute drained vault into strategy
        assertEq(IERC20(USDC).balanceOf(address(vault)), vaultBalanceBefore - DEPOSIT, "vault drained");
        assertEq(IERC20(USDC).balanceOf(clone), DEPOSIT, "strategy holds DEPOSIT");

        // 5. Agent calls updateParams(ACTION_PLACE_GRID, ...) with 6 GTC orders
        HyperliquidGridStrategy.GridOrder[] memory orders = new HyperliquidGridStrategy.GridOrder[](6);
        orders[0] = _gridOrder(HL_BTC, true, 76000_0, 1000, 1); // BTC limitPx scaled
        orders[1] = _gridOrder(HL_BTC, false, 78000_0, 1000, 2);
        orders[2] = _gridOrder(HL_ETH, true, 2300_00, 100, 3);
        orders[3] = _gridOrder(HL_ETH, false, 2400_00, 100, 4);
        orders[4] = _gridOrder(HL_SOL, true, 85_0000, 100, 5);
        orders[5] = _gridOrder(HL_SOL, false, 90_0000, 100, 6);
        bytes memory placeData = abi.encode(uint8(1), orders);

        vm.recordLogs();
        vm.prank(agent);
        strategy.updateParams(placeData);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // Each order emits one RawAction event from CORE_WRITER + one GridOrderPlaced from strategy
        uint256 rawActionCount = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == CORE_WRITER) rawActionCount++;
        }
        assertEq(rawActionCount, 6, "6 RawAction events");

        // 6. Warp past strategy duration, settle
        vm.warp(block.timestamp + DURATION + 1);
        governor.settleProposal(proposalId);

        // 7. Sweep — strategy USDC returns to vault (still has DEPOSIT since fork can't move it)
        strategy.sweepToVault();
        assertEq(IERC20(USDC).balanceOf(clone), 0, "strategy drained");
        assertGt(IERC20(USDC).balanceOf(address(vault)), 0, "vault refilled");

        // 8. LPs redeem proportional shares
        uint256 lp1Shares = vault.balanceOf(lp1);
        uint256 lp2Shares = vault.balanceOf(lp2);

        vm.prank(lp1);
        vault.redeem(lp1Shares, lp1, lp1);
        vm.prank(lp2);
        vault.redeem(lp2Shares, lp2, lp2);

        // Total returned ≈ deposited (no on-chain loss since HyperCore didn't process anything)
        assertApproxEqAbs(IERC20(USDC).balanceOf(lp1) + IERC20(USDC).balanceOf(lp2), 100_000e6, 100, "lps redeemed");
    }

    function test_fullLifecycle_cancelAndPlaceRebalance() public {
        // Setup through initial place
        address clone = _cloneAndInit(hyperliquidGridTemplate, _initData());
        HyperliquidGridStrategy strategy = HyperliquidGridStrategy(clone);
        (BatchExecutorLib.Call[] memory exec, BatchExecutorLib.Call[] memory settle) = _execAndSettleCalls(clone);
        uint256 proposalId = _proposeVoteApprove(exec, settle, 1000, DURATION);

        // Initial place (BTC only, 2 orders)
        HyperliquidGridStrategy.GridOrder[] memory orders = new HyperliquidGridStrategy.GridOrder[](2);
        orders[0] = _gridOrder(HL_BTC, true, 76000_0, 1000, 100);
        orders[1] = _gridOrder(HL_BTC, false, 78000_0, 1000, 101);
        vm.prank(agent);
        strategy.updateParams(abi.encode(uint8(1), orders));

        // Cancel-and-place rebalance: cancel old CLOIDs, place new ones
        uint128[] memory oldCloids = new uint128[](2);
        oldCloids[0] = 100;
        oldCloids[1] = 101;
        HyperliquidGridStrategy.GridOrder[] memory newOrders = new HyperliquidGridStrategy.GridOrder[](2);
        newOrders[0] = _gridOrder(HL_BTC, true, 77000_0, 1000, 200);
        newOrders[1] = _gridOrder(HL_BTC, false, 79000_0, 1000, 201);

        vm.recordLogs();
        vm.prank(agent);
        strategy.updateParams(abi.encode(uint8(3), HL_BTC, oldCloids, newOrders));
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // Expect 4 RawAction events: 2 cancels + 2 places
        uint256 rawActionCount = 0;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == CORE_WRITER) rawActionCount++;
        }
        assertEq(rawActionCount, 4, "2 cancels + 2 places");

        // Settle + sweep happy path
        vm.warp(block.timestamp + DURATION + 1);
        governor.settleProposal(proposalId);
        strategy.sweepToVault();
        assertEq(IERC20(USDC).balanceOf(clone), 0);
    }

    function test_fullLifecycle_lossyStrategyStillReturnsFunds() public {
        // Setup through execute
        address clone = _cloneAndInit(hyperliquidGridTemplate, _initData());
        HyperliquidGridStrategy strategy = HyperliquidGridStrategy(clone);
        (BatchExecutorLib.Call[] memory exec, BatchExecutorLib.Call[] memory settle) = _execAndSettleCalls(clone);
        uint256 proposalId = _proposeVoteApprove(exec, settle, 1000, DURATION);

        // Simulate a loss: drain most of the strategy's USDC to a burn address
        address burn = makeAddr("burn");
        uint256 leftover = 1_000e6; // strategy "lost" 49,000 USDC
        vm.prank(clone);
        IERC20(USDC).transfer(burn, DEPOSIT - leftover);
        assertEq(IERC20(USDC).balanceOf(clone), leftover, "strategy down to leftover");

        // Settle + sweep — must succeed despite the "loss"
        vm.warp(block.timestamp + DURATION + 1);
        governor.settleProposal(proposalId);
        uint256 vaultBefore = IERC20(USDC).balanceOf(address(vault));
        strategy.sweepToVault();
        assertEq(IERC20(USDC).balanceOf(address(vault)), vaultBefore + leftover, "vault gets remainder");
        assertEq(strategy.cumulativeSwept(), leftover, "cumulativeSwept advances");

        // LPs can still redeem proportional shares against the diminished vault
        uint256 lp1Shares = vault.balanceOf(lp1);
        vm.prank(lp1);
        uint256 lp1Got = vault.redeem(lp1Shares, lp1, lp1);
        assertGt(lp1Got, 0, "lp1 redeems non-zero (proportional to remaining)");
    }

    function _gridOrder(uint32 ai, bool isBuy, uint64 px, uint64 sz, uint128 cloid)
        internal
        pure
        returns (HyperliquidGridStrategy.GridOrder memory)
    {
        return HyperliquidGridStrategy.GridOrder({assetIndex: ai, isBuy: isBuy, limitPx: px, sz: sz, cloid: cloid});
    }
}
