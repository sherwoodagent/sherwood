// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {BatchExecutor} from "../src/BatchExecutor.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockMToken} from "./mocks/MockMToken.sol";
import {MockComptroller} from "./mocks/MockComptroller.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";

contract BatchExecutorTest is Test {
    BatchExecutor public executor;
    ERC20Mock public usdc;
    ERC20Mock public weth;
    MockMToken public mUSDC;
    MockComptroller public comptroller;
    MockSwapRouter public swapRouter;

    address public vault = makeAddr("vault");
    address public owner = makeAddr("owner");

    function setUp() public {
        // Deploy tokens
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        weth = new ERC20Mock("Wrapped Ether", "WETH", 18);

        // Deploy Moonwell mocks
        mUSDC = new MockMToken(address(usdc), "Moonwell USDC", "mUSDC");
        comptroller = new MockComptroller();
        swapRouter = new MockSwapRouter();

        // Deploy executor
        executor = new BatchExecutor(vault, owner);

        // Add targets to allowlist
        vm.startPrank(owner);
        address[] memory targets = new address[](5);
        targets[0] = address(usdc);
        targets[1] = address(weth);
        targets[2] = address(mUSDC);
        targets[3] = address(comptroller);
        targets[4] = address(swapRouter);
        executor.addTargets(targets);
        vm.stopPrank();

        // Fund executor with USDC (simulating vault having sent assets)
        usdc.mint(address(executor), 100_000e6);

        // Fund mToken with underlying for borrow liquidity
        usdc.mint(address(mUSDC), 1_000_000e6);

        // Fund swap router
        weth.mint(address(swapRouter), 1_000e18);
    }

    // ==================== TARGET MANAGEMENT ====================

    function test_addTarget() public {
        address newTarget = makeAddr("newProtocol");

        vm.prank(owner);
        executor.addTarget(newTarget);

        assertTrue(executor.isAllowedTarget(newTarget));
        assertEq(executor.allowedTargetCount(), 6); // 5 from setUp + 1
    }

    function test_removeTarget() public {
        vm.prank(owner);
        executor.removeTarget(address(swapRouter));

        assertFalse(executor.isAllowedTarget(address(swapRouter)));
    }

    function test_addTarget_notOwner_reverts() public {
        vm.prank(makeAddr("rando"));
        vm.expectRevert();
        executor.addTarget(makeAddr("target"));
    }

    function test_getAllowedTargets() public view {
        address[] memory targets = executor.getAllowedTargets();
        assertEq(targets.length, 5);
    }

    // ==================== BATCH EXECUTION ====================

    function test_singleCall() public {
        // Approve mToken to pull USDC from executor
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](1);
        calls[0] = BatchExecutor.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUSDC), 10_000e6)), value: 0
        });

        vm.prank(vault);
        executor.executeBatch(calls);

        assertEq(usdc.allowance(address(executor), address(mUSDC)), 10_000e6);
    }

    function test_moonwellDepositBatch() public {
        // Real Moonwell flow: approve → mint → enterMarkets
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](3);

        // 1. Approve mToken to pull USDC
        calls[0] = BatchExecutor.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUSDC), 10_000e6)), value: 0
        });

        // 2. Mint mTokens (deposit collateral)
        calls[1] = BatchExecutor.Call({
            target: address(mUSDC), data: abi.encodeWithSignature("mint(uint256)", 10_000e6), value: 0
        });

        // 3. Enter market as collateral
        address[] memory markets = new address[](1);
        markets[0] = address(mUSDC);
        calls[2] = BatchExecutor.Call({
            target: address(comptroller), data: abi.encodeCall(comptroller.enterMarkets, (markets)), value: 0
        });

        vm.prank(vault);
        executor.executeBatch(calls);

        // Executor should hold mTokens
        assertEq(mUSDC.balanceOf(address(executor)), 10_000e6);
    }

    function test_fullLeveragedLong() public {
        // Full flow: approve → deposit → enterMarkets → borrow
        // The mToken.borrow() sends USDC directly to executor (msg.sender)
        // No target allowlist issue since executor IS the caller

        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](4);

        // 1. Approve mToken to pull USDC
        calls[0] = BatchExecutor.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUSDC), 10_000e6)), value: 0
        });

        // 2. Deposit collateral
        calls[1] = BatchExecutor.Call({
            target: address(mUSDC), data: abi.encodeWithSignature("mint(uint256)", 10_000e6), value: 0
        });

        // 3. Enter market
        address[] memory markets = new address[](1);
        markets[0] = address(mUSDC);
        calls[2] = BatchExecutor.Call({
            target: address(comptroller), data: abi.encodeCall(comptroller.enterMarkets, (markets)), value: 0
        });

        // 4. Borrow USDC (goes to executor since executor is msg.sender)
        calls[3] = BatchExecutor.Call({
            target: address(mUSDC), data: abi.encodeWithSignature("borrow(uint256)", 5_000e6), value: 0
        });

        vm.prank(vault);
        executor.executeBatch(calls);

        // Verify collateral deposited
        assertEq(mUSDC.balanceOf(address(executor)), 10_000e6);
        // Verify borrow — executor got 5k back (100k - 10k + 5k = 95k)
        assertEq(usdc.balanceOf(address(executor)), 95_000e6);
    }

    function test_disallowedTarget_reverts() public {
        address evil = makeAddr("evilContract");

        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](1);
        calls[0] = BatchExecutor.Call({target: evil, data: "", value: 0});

        vm.prank(vault);
        vm.expectRevert("Target not allowed");
        executor.executeBatch(calls);
    }

    function test_onlyVault() public {
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](0);

        vm.prank(makeAddr("attacker"));
        vm.expectRevert("Only vault");
        executor.executeBatch(calls);
    }

    function test_batchAtomicity_failedCallRevertsAll() public {
        // Call a disallowed target mid-batch — everything reverts
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](2);

        // 1. Approve (succeeds)
        calls[0] = BatchExecutor.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUSDC), 10_000e6)), value: 0
        });

        // 2. Call disallowed target (reverts entire batch)
        calls[1] = BatchExecutor.Call({target: makeAddr("notAllowed"), data: "", value: 0});

        vm.prank(vault);
        vm.expectRevert("Target not allowed");
        executor.executeBatch(calls);

        // Approve from step 1 should NOT have persisted
        assertEq(usdc.allowance(address(executor), address(mUSDC)), 0);
    }

    // ==================== SIMULATION ====================

    function test_simulateBatch_success() public {
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](1);
        calls[0] = BatchExecutor.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUSDC), 10_000e6)), value: 0
        });

        vm.prank(vault);
        BatchExecutor.CallResult[] memory results = executor.simulateBatch(calls);

        assertEq(results.length, 1);
        assertTrue(results[0].success);
    }

    function test_simulateBatch_disallowedTarget() public {
        BatchExecutor.Call[] memory calls = new BatchExecutor.Call[](1);
        calls[0] = BatchExecutor.Call({target: makeAddr("evil"), data: "", value: 0});

        vm.prank(vault);
        BatchExecutor.CallResult[] memory results = executor.simulateBatch(calls);

        assertFalse(results[0].success);
        assertEq(string(results[0].returnData), "Target not allowed");
    }
}
