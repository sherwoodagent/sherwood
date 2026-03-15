// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {ISyndicateVault} from "../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockMToken} from "./mocks/MockMToken.sol";
import {MockComptroller} from "./mocks/MockComptroller.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";

contract SyndicateVaultTest is Test {
    SyndicateVault public vault;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    ERC20Mock public weth;
    MockMToken public mUsdc;
    MockComptroller public comptroller;
    MockSwapRouter public swapRouter;

    address public owner = makeAddr("owner");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public agentPkp = makeAddr("agentPkp");
    address public agentEoa = makeAddr("agentEoa");
    address public agentPkp2 = makeAddr("agentPkp2");
    address public agentEoa2 = makeAddr("agentEoa2");

    uint256 constant MAX_PER_TX = 10_000e6; // 10k USDC (6 decimals)
    uint256 constant MAX_DAILY = 50_000e6; // 50k USDC
    uint256 constant MAX_BORROW = 7500; // 75% LTV

    function setUp() public {
        // Deploy tokens
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        weth = new ERC20Mock("Wrapped Ether", "WETH", 18);

        // Deploy DeFi mocks
        mUsdc = new MockMToken(address(usdc), "Moonwell USDC", "mUsdc");
        comptroller = new MockComptroller();
        swapRouter = new MockSwapRouter();

        // Deploy shared executor lib
        executorLib = new BatchExecutorLib();

        // Allowlist targets
        address[] memory targets = new address[](5);
        targets[0] = address(usdc);
        targets[1] = address(weth);
        targets[2] = address(mUsdc);
        targets[3] = address(comptroller);
        targets[4] = address(swapRouter);

        // Deploy vault via proxy with executor lib and initial targets
        SyndicateVault impl = new SyndicateVault();
        bytes memory initData = abi.encodeCall(
            SyndicateVault.initialize,
            (
                usdc,
                "Sherwood Vault",
                "shUSDC",
                owner,
                ISyndicateVault.SyndicateCaps({
                    maxPerTx: MAX_PER_TX, maxDailyTotal: MAX_DAILY, maxBorrowRatio: MAX_BORROW
                }),
                address(executorLib),
                targets,
                true // openDeposits = true for test convenience
            )
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vault = SyndicateVault(payable(address(proxy)));

        // Mint USDC to LPs
        usdc.mint(lp1, 100_000e6);
        usdc.mint(lp2, 100_000e6);

        // Fund mToken with underlying for borrow liquidity
        usdc.mint(address(mUsdc), 1_000_000e6);

        // Fund swap router
        weth.mint(address(swapRouter), 1_000e18);

        // Register agent
        vm.prank(owner);
        vault.registerAgent(agentPkp, agentEoa, 5_000e6, 20_000e6);
    }

    // ==================== INITIALIZATION ====================

    function test_initialize() public view {
        assertEq(vault.name(), "Sherwood Vault");
        assertEq(vault.symbol(), "shUSDC");
        assertEq(vault.owner(), owner);
        assertEq(address(vault.asset()), address(usdc));
        assertEq(vault.getExecutorImpl(), address(executorLib));

        ISyndicateVault.SyndicateCaps memory caps = vault.getSyndicateCaps();
        assertEq(caps.maxPerTx, MAX_PER_TX);
        assertEq(caps.maxDailyTotal, MAX_DAILY);
        assertEq(caps.maxBorrowRatio, MAX_BORROW);
    }

    function test_initialize_withTargets() public view {
        assertTrue(vault.isAllowedTarget(address(usdc)));
        assertTrue(vault.isAllowedTarget(address(weth)));
        assertTrue(vault.isAllowedTarget(address(mUsdc)));
        assertTrue(vault.isAllowedTarget(address(comptroller)));
        assertTrue(vault.isAllowedTarget(address(swapRouter)));

        address[] memory targets = vault.getAllowedTargets();
        assertEq(targets.length, 5);
    }

    // ==================== DEPOSITS & WITHDRAWALS ====================

    function test_deposit() public {
        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        uint256 shares = vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        assertGt(shares, 0);
        assertEq(vault.balanceOf(lp1), shares);
    }

    function test_ragequit() public {
        // LP1 deposits
        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        // LP2 deposits
        vm.startPrank(lp2);
        usdc.approve(address(vault), 5_000e6);
        vault.deposit(5_000e6, lp2);
        vm.stopPrank();

        uint256 balBefore = usdc.balanceOf(lp1);

        // LP1 ragequits
        vm.prank(lp1);
        uint256 assets = vault.ragequit(lp1);

        assertEq(assets, 10_000e6);
        assertEq(usdc.balanceOf(lp1), balBefore + 10_000e6);
        assertEq(vault.balanceOf(lp1), 0);
        // LP2 still has their shares
        assertGt(vault.balanceOf(lp2), 0);
    }

    function test_ragequit_noShares_reverts() public {
        vm.prank(lp1);
        vm.expectRevert("No shares");
        vault.ragequit(lp1);
    }

    // ==================== AGENT REGISTRATION ====================

    function test_registerAgent() public view {
        assertTrue(vault.isAgent(agentPkp));
        assertEq(vault.getAgentCount(), 1);

        ISyndicateVault.AgentConfig memory config = vault.getAgentConfig(agentPkp);
        assertEq(config.pkpAddress, agentPkp);
        assertEq(config.operatorEOA, agentEoa);
        assertEq(config.maxPerTx, 5_000e6);
        assertEq(config.dailyLimit, 20_000e6);
        assertTrue(config.active);
    }

    function test_registerAgent_exceedsSyndicateCap_reverts() public {
        vm.prank(owner);
        vm.expectRevert("Agent maxPerTx > syndicate cap");
        vault.registerAgent(agentPkp2, agentEoa2, MAX_PER_TX + 1, 20_000e6);
    }

    function test_registerAgent_notOwner_reverts() public {
        vm.prank(lp1);
        vm.expectRevert();
        vault.registerAgent(agentPkp2, agentEoa2, 5_000e6, 20_000e6);
    }

    function test_removeAgent() public {
        vm.prank(owner);
        vault.removeAgent(agentPkp);

        assertFalse(vault.isAgent(agentPkp));
        assertEq(vault.getAgentCount(), 0);
    }

    // ==================== TARGET MANAGEMENT ====================

    function test_addTarget() public {
        address newTarget = makeAddr("newProtocol");

        vm.prank(owner);
        vault.addTarget(newTarget);

        assertTrue(vault.isAllowedTarget(newTarget));
        assertEq(vault.getAllowedTargets().length, 6); // 5 from setUp + 1
    }

    function test_removeTarget() public {
        vm.prank(owner);
        vault.removeTarget(address(swapRouter));

        assertFalse(vault.isAllowedTarget(address(swapRouter)));
    }

    function test_addTarget_notOwner_reverts() public {
        vm.prank(makeAddr("rando"));
        vm.expectRevert();
        vault.addTarget(makeAddr("target"));
    }

    function test_addTargets() public {
        address t1 = makeAddr("t1");
        address t2 = makeAddr("t2");
        address[] memory newTargets = new address[](2);
        newTargets[0] = t1;
        newTargets[1] = t2;

        vm.prank(owner);
        vault.addTargets(newTargets);

        assertTrue(vault.isAllowedTarget(t1));
        assertTrue(vault.isAllowedTarget(t2));
        assertEq(vault.getAllowedTargets().length, 7); // 5 + 2
    }

    // ==================== BATCH EXECUTION (via delegatecall) ====================

    /// @dev Helper: fund the vault directly with USDC for batch tests
    function _fundVault(uint256 amount) internal {
        usdc.mint(address(vault), amount);
    }

    function test_executeBatch_singleCall() public {
        _fundVault(100_000e6);

        // Agent approves mToken to pull USDC from vault
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUsdc), 10_000e6)), value: 0
        });

        vm.prank(agentPkp);
        vault.executeBatch(calls, 0);

        // Allowance is set on the VAULT (delegatecall), not some external executor
        assertEq(usdc.allowance(address(vault), address(mUsdc)), 10_000e6);
    }

    function test_executeBatch_moonwellDeposit() public {
        _fundVault(100_000e6);

        // Real Moonwell flow: approve → mint → enterMarkets
        // All calls execute as the vault via delegatecall
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](3);

        // 1. Approve mToken to pull USDC
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUsdc), 10_000e6)), value: 0
        });

        // 2. Mint mTokens (deposit collateral)
        calls[1] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("mint(uint256)", 10_000e6), value: 0
        });

        // 3. Enter market as collateral
        address[] memory markets = new address[](1);
        markets[0] = address(mUsdc);
        calls[2] = BatchExecutorLib.Call({
            target: address(comptroller), data: abi.encodeCall(comptroller.enterMarkets, (markets)), value: 0
        });

        vm.prank(agentPkp);
        vault.executeBatch(calls, 0);

        // VAULT holds the mTokens (not some separate executor)
        assertEq(mUsdc.balanceOf(address(vault)), 10_000e6);
    }

    function test_executeBatch_fullLeveragedLong() public {
        _fundVault(100_000e6);

        // Full flow: approve → deposit → enterMarkets → borrow
        // Positions live on the vault via delegatecall
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](4);

        // 1. Approve mToken to pull USDC
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUsdc), 10_000e6)), value: 0
        });

        // 2. Deposit collateral
        calls[1] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("mint(uint256)", 10_000e6), value: 0
        });

        // 3. Enter market
        address[] memory markets = new address[](1);
        markets[0] = address(mUsdc);
        calls[2] = BatchExecutorLib.Call({
            target: address(comptroller), data: abi.encodeCall(comptroller.enterMarkets, (markets)), value: 0
        });

        // 4. Borrow USDC (goes to vault since vault is msg.sender via delegatecall)
        calls[3] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("borrow(uint256)", 5_000e6), value: 0
        });

        vm.prank(agentPkp);
        vault.executeBatch(calls, 0);

        // Vault holds mTokens
        assertEq(mUsdc.balanceOf(address(vault)), 10_000e6);
        // Vault got borrow proceeds (100k - 10k deposited + 5k borrowed = 95k)
        assertEq(usdc.balanceOf(address(vault)), 95_000e6);
    }

    function test_executeBatch_disallowedTarget_reverts() public {
        address evil = makeAddr("evilContract");

        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({target: evil, data: "", value: 0});

        vm.prank(agentPkp);
        vm.expectRevert("Target not allowed");
        vault.executeBatch(calls, 0);
    }

    function test_executeBatch_notAgent_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        vm.prank(makeAddr("attacker"));
        vm.expectRevert("Not an active agent");
        vault.executeBatch(calls, 0);
    }

    function test_executeBatch_atomicity() public {
        // Call a disallowed target mid-batch — everything reverts
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);

        // 1. Approve (would succeed)
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUsdc), 10_000e6)), value: 0
        });

        // 2. Call disallowed target (allowlist check catches this before delegatecall)
        calls[1] = BatchExecutorLib.Call({target: makeAddr("notAllowed"), data: "", value: 0});

        vm.prank(agentPkp);
        vm.expectRevert("Target not allowed");
        vault.executeBatch(calls, 0);

        // Approve from step 1 should NOT have persisted
        assertEq(usdc.allowance(address(vault), address(mUsdc)), 0);
    }

    function test_executeBatch_whenPaused_reverts() public {
        vm.prank(owner);
        vault.pause();

        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        vm.prank(agentPkp);
        vm.expectRevert();
        vault.executeBatch(calls, 0);
    }

    // ==================== CAPS ENFORCEMENT ====================

    function test_executeBatch_exceedsPerTxCap_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        // Agent cap is 5000e6 — try 6000e6
        vm.prank(agentPkp);
        vm.expectRevert("Exceeds per-tx cap");
        vault.executeBatch(calls, 6_000e6);
    }

    function test_executeBatch_exceedsDailyLimit_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        // Agent spends up to daily limit (20k = 4 * 5k)
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(agentPkp);
            vault.executeBatch(calls, 5_000e6);
        }

        // Next tx should fail (20k daily limit, already spent 20k)
        vm.prank(agentPkp);
        vm.expectRevert("Exceeds agent daily limit");
        vault.executeBatch(calls, 1_000e6);
    }

    function test_executeBatch_dailyResets() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        // Agent spends to daily limit
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(agentPkp);
            vault.executeBatch(calls, 5_000e6);
        }

        // Warp to next day
        vm.warp(block.timestamp + 1 days);

        // Should work again
        vm.prank(agentPkp);
        vault.executeBatch(calls, 5_000e6);

        ISyndicateVault.AgentConfig memory config = vault.getAgentConfig(agentPkp);
        assertEq(config.spentToday, 5_000e6); // Reset to just this tx
    }

    function test_executeBatch_syndicateDailyLimit() public {
        // Register second agent with high limit
        vm.prank(owner);
        vault.registerAgent(agentPkp2, agentEoa2, MAX_PER_TX, MAX_DAILY);

        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        // Agent 1 spends 20k
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(agentPkp);
            vault.executeBatch(calls, 5_000e6);
        }

        // Agent 2 spends 30k (up to 50k syndicate total)
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(agentPkp2);
            vault.executeBatch(calls, 10_000e6);
        }

        // Agent 2 tries one more — hits syndicate daily limit (50k)
        vm.prank(agentPkp2);
        vm.expectRevert("Exceeds syndicate daily limit");
        vault.executeBatch(calls, 1_000e6);
    }

    function test_executeBatch_spendTracking() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        vm.prank(agentPkp);
        vault.executeBatch(calls, 1_000e6);

        ISyndicateVault.AgentConfig memory config = vault.getAgentConfig(agentPkp);
        assertEq(config.spentToday, 1_000e6);
        assertEq(vault.getDailySpendTotal(), 1_000e6);
    }

    // ==================== SIMULATION ====================

    function test_simulateBatch_success() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUsdc), 10_000e6)), value: 0
        });

        // Anyone can simulate (no agent check)
        BatchExecutorLib.CallResult[] memory results = vault.simulateBatch(calls);

        assertEq(results.length, 1);
        assertTrue(results[0].success);
    }

    function test_simulateBatch_disallowedTarget() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({target: makeAddr("evil"), data: "", value: 0});

        BatchExecutorLib.CallResult[] memory results = vault.simulateBatch(calls);

        assertFalse(results[0].success);
        assertEq(string(results[0].returnData), "Target not allowed");
    }

    // ==================== FUZZ TESTS ====================

    function testFuzz_capsEnforcement(uint256 amount) public {
        // Bound to reasonable range
        amount = bound(amount, 0, 100_000e6);
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        if (amount > 5_000e6) {
            // Exceeds agent per-tx cap
            vm.prank(agentPkp);
            vm.expectRevert("Exceeds per-tx cap");
            vault.executeBatch(calls, amount);
        } else {
            vm.prank(agentPkp);
            vault.executeBatch(calls, amount);

            ISyndicateVault.AgentConfig memory config = vault.getAgentConfig(agentPkp);
            assertEq(config.spentToday, amount);
        }
    }

    // ==================== PAUSE ====================

    function test_pause_blocksDeposits() public {
        vm.prank(owner);
        vault.pause();

        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        vm.expectRevert();
        vault.deposit(10_000e6, lp1);
        vm.stopPrank();
    }

    // ==================== SYNDICATE CAPS ====================

    function test_updateSyndicateCaps() public {
        vm.prank(owner);
        vault.updateSyndicateCaps(
            ISyndicateVault.SyndicateCaps({maxPerTx: 20_000e6, maxDailyTotal: 100_000e6, maxBorrowRatio: 8000})
        );

        ISyndicateVault.SyndicateCaps memory caps = vault.getSyndicateCaps();
        assertEq(caps.maxPerTx, 20_000e6);
        assertEq(caps.maxDailyTotal, 100_000e6);
        assertEq(caps.maxBorrowRatio, 8000);
    }

    // ==================== RECEIVE ETH ====================

    function test_vaultReceivesETH() public {
        vm.deal(address(this), 1 ether);
        (bool success,) = address(vault).call{value: 1 ether}("");
        assertTrue(success);
        assertEq(address(vault).balance, 1 ether);
    }

    // ==================== DEPOSITOR WHITELIST ====================

    function test_approveDepositor() public {
        address depositor = makeAddr("depositor");

        vm.prank(owner);
        vault.approveDepositor(depositor);

        assertTrue(vault.isApprovedDepositor(depositor));

        address[] memory depositors = vault.getApprovedDepositors();
        assertEq(depositors.length, 1);
        assertEq(depositors[0], depositor);
    }

    function test_approveDepositor_notOwner_reverts() public {
        vm.prank(lp1);
        vm.expectRevert();
        vault.approveDepositor(makeAddr("depositor"));
    }

    function test_removeDepositor() public {
        address depositor = makeAddr("depositor");
        vm.startPrank(owner);
        vault.approveDepositor(depositor);
        vault.removeDepositor(depositor);
        vm.stopPrank();

        assertFalse(vault.isApprovedDepositor(depositor));
    }

    function test_approveDepositors_batch() public {
        address[] memory depositors = new address[](3);
        depositors[0] = makeAddr("d1");
        depositors[1] = makeAddr("d2");
        depositors[2] = makeAddr("d3");

        vm.prank(owner);
        vault.approveDepositors(depositors);

        assertTrue(vault.isApprovedDepositor(depositors[0]));
        assertTrue(vault.isApprovedDepositor(depositors[1]));
        assertTrue(vault.isApprovedDepositor(depositors[2]));
        assertEq(vault.getApprovedDepositors().length, 3);
    }

    function test_deposit_closedDeposits_unapproved_reverts() public {
        // Deploy a vault with openDeposits=false
        SyndicateVault impl2 = new SyndicateVault();
        address[] memory targets = new address[](1);
        targets[0] = address(usdc);
        bytes memory initData = abi.encodeCall(
            SyndicateVault.initialize,
            (
                usdc,
                "Closed Vault",
                "cVault",
                owner,
                ISyndicateVault.SyndicateCaps({
                    maxPerTx: MAX_PER_TX, maxDailyTotal: MAX_DAILY, maxBorrowRatio: MAX_BORROW
                }),
                address(executorLib),
                targets,
                false // openDeposits = false
            )
        );
        ERC1967Proxy proxy2 = new ERC1967Proxy(address(impl2), initData);
        SyndicateVault closedVault = SyndicateVault(payable(address(proxy2)));

        // Try to deposit without approval — should revert
        usdc.mint(lp1, 10_000e6);
        vm.startPrank(lp1);
        usdc.approve(address(closedVault), 10_000e6);
        vm.expectRevert("Not approved depositor");
        closedVault.deposit(10_000e6, lp1);
        vm.stopPrank();
    }

    function test_deposit_closedDeposits_approved_succeeds() public {
        // Deploy a vault with openDeposits=false
        SyndicateVault impl2 = new SyndicateVault();
        address[] memory targets = new address[](1);
        targets[0] = address(usdc);
        bytes memory initData = abi.encodeCall(
            SyndicateVault.initialize,
            (
                usdc,
                "Closed Vault",
                "cVault",
                owner,
                ISyndicateVault.SyndicateCaps({
                    maxPerTx: MAX_PER_TX, maxDailyTotal: MAX_DAILY, maxBorrowRatio: MAX_BORROW
                }),
                address(executorLib),
                targets,
                false
            )
        );
        ERC1967Proxy proxy2 = new ERC1967Proxy(address(impl2), initData);
        SyndicateVault closedVault = SyndicateVault(payable(address(proxy2)));

        // Approve depositor
        vm.prank(owner);
        closedVault.approveDepositor(lp1);

        // Now deposit should succeed
        usdc.mint(lp1, 10_000e6);
        vm.startPrank(lp1);
        usdc.approve(address(closedVault), 10_000e6);
        uint256 shares = closedVault.deposit(10_000e6, lp1);
        vm.stopPrank();

        assertGt(shares, 0);
    }

    function test_setOpenDeposits() public {
        // Deploy closed vault
        SyndicateVault impl2 = new SyndicateVault();
        address[] memory targets = new address[](1);
        targets[0] = address(usdc);
        bytes memory initData = abi.encodeCall(
            SyndicateVault.initialize,
            (
                usdc,
                "Closed Vault",
                "cVault",
                owner,
                ISyndicateVault.SyndicateCaps({
                    maxPerTx: MAX_PER_TX, maxDailyTotal: MAX_DAILY, maxBorrowRatio: MAX_BORROW
                }),
                address(executorLib),
                targets,
                false
            )
        );
        ERC1967Proxy proxy2 = new ERC1967Proxy(address(impl2), initData);
        SyndicateVault closedVault = SyndicateVault(payable(address(proxy2)));

        // Toggle to open
        vm.prank(owner);
        closedVault.setOpenDeposits(true);
        assertTrue(closedVault.openDeposits());

        // Now anyone can deposit
        usdc.mint(lp1, 10_000e6);
        vm.startPrank(lp1);
        usdc.approve(address(closedVault), 10_000e6);
        uint256 shares = closedVault.deposit(10_000e6, lp1);
        vm.stopPrank();

        assertGt(shares, 0);
    }

    function test_openDeposits_initialized_true() public view {
        // The main vault in setUp was created with openDeposits=true
        assertTrue(vault.openDeposits());
    }
}
