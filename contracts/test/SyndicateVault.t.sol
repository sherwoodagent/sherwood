// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {ISyndicateVault} from "../src/interfaces/ISyndicateVault.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockStrategy} from "./mocks/MockStrategy.sol";

contract SyndicateVaultTest is Test {
    SyndicateVault public vault;
    ERC20Mock public usdc;
    MockStrategy public strategy;

    address public owner = makeAddr("owner");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public agentPKP = makeAddr("agentPKP");
    address public agentEOA = makeAddr("agentEOA");
    address public agentPKP2 = makeAddr("agentPKP2");
    address public agentEOA2 = makeAddr("agentEOA2");

    uint256 constant MAX_PER_TX = 10_000e6; // 10k USDC (6 decimals)
    uint256 constant MAX_DAILY = 50_000e6; // 50k USDC
    uint256 constant MAX_BORROW = 7500; // 75% LTV

    function setUp() public {
        // Deploy mock USDC (6 decimals)
        usdc = new ERC20Mock("USD Coin", "USDC", 6);

        // Deploy vault via proxy
        SyndicateVault impl = new SyndicateVault();
        bytes memory initData = abi.encodeCall(
            SyndicateVault.initialize,
            (
                usdc,
                "Sherwood Vault",
                "shUSDC",
                owner,
                ISyndicateVault.SyndicateCaps({
                    maxPerTx: MAX_PER_TX,
                    maxDailyTotal: MAX_DAILY,
                    maxBorrowRatio: MAX_BORROW
                })
            )
        );
        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initData);
        vault = SyndicateVault(address(proxy));

        // Deploy mock strategy
        strategy = new MockStrategy(address(vault), address(usdc));

        // Mint USDC to LPs
        usdc.mint(lp1, 100_000e6);
        usdc.mint(lp2, 100_000e6);

        // Register agent
        vm.prank(owner);
        vault.registerAgent(agentPKP, agentEOA, 5_000e6, 20_000e6);
    }

    // ==================== INITIALIZATION ====================

    function test_initialize() public view {
        assertEq(vault.name(), "Sherwood Vault");
        assertEq(vault.symbol(), "shUSDC");
        assertEq(vault.owner(), owner);
        assertEq(address(vault.asset()), address(usdc));

        ISyndicateVault.SyndicateCaps memory caps = vault.getSyndicateCaps();
        assertEq(caps.maxPerTx, MAX_PER_TX);
        assertEq(caps.maxDailyTotal, MAX_DAILY);
        assertEq(caps.maxBorrowRatio, MAX_BORROW);
    }

    // ==================== DEPOSITS & WITHDRAWALS ====================

    function test_deposit() public {
        vm.startPrank(lp1);
        usdc.approve(address(vault), 10_000e6);
        uint256 shares = vault.deposit(10_000e6, lp1);
        vm.stopPrank();

        assertGt(shares, 0);
        assertEq(vault.totalAssets(), 10_000e6);
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
        assertTrue(vault.isAgent(agentPKP));
        assertEq(vault.getAgentCount(), 1);

        ISyndicateVault.AgentConfig memory config = vault.getAgentConfig(agentPKP);
        assertEq(config.pkpAddress, agentPKP);
        assertEq(config.operatorEOA, agentEOA);
        assertEq(config.maxPerTx, 5_000e6);
        assertEq(config.dailyLimit, 20_000e6);
        assertTrue(config.active);
    }

    function test_registerAgent_exceedsSyndicateCap_reverts() public {
        vm.prank(owner);
        vm.expectRevert("Agent maxPerTx > syndicate cap");
        vault.registerAgent(agentPKP2, agentEOA2, MAX_PER_TX + 1, 20_000e6);
    }

    function test_registerAgent_notOwner_reverts() public {
        vm.prank(lp1);
        vm.expectRevert();
        vault.registerAgent(agentPKP2, agentEOA2, 5_000e6, 20_000e6);
    }

    function test_removeAgent() public {
        vm.prank(owner);
        vault.removeAgent(agentPKP);

        assertFalse(vault.isAgent(agentPKP));
        assertEq(vault.getAgentCount(), 0);
    }

    // ==================== STRATEGY EXECUTION ====================

    function test_executeStrategy() public {
        // Fund vault
        vm.startPrank(lp1);
        usdc.approve(address(vault), 50_000e6);
        vault.deposit(50_000e6, lp1);
        vm.stopPrank();

        // Agent executes strategy
        bytes memory callData = abi.encodeCall(MockStrategy.execute, (1_000e6));
        vm.prank(agentPKP);
        vault.executeStrategy(address(strategy), callData, 1_000e6);

        // Check spend tracking
        ISyndicateVault.AgentConfig memory config = vault.getAgentConfig(agentPKP);
        assertEq(config.spentToday, 1_000e6);
        assertEq(vault.getDailySpendTotal(), 1_000e6);
    }

    function test_executeStrategy_exceedsPerTxCap_reverts() public {
        // Fund vault
        vm.startPrank(lp1);
        usdc.approve(address(vault), 50_000e6);
        vault.deposit(50_000e6, lp1);
        vm.stopPrank();

        // Agent tries to exceed per-tx cap (agent cap is 5000e6)
        bytes memory callData = abi.encodeCall(MockStrategy.execute, (6_000e6));
        vm.prank(agentPKP);
        vm.expectRevert("Exceeds per-tx cap");
        vault.executeStrategy(address(strategy), callData, 6_000e6);
    }

    function test_executeStrategy_exceedsDailyLimit_reverts() public {
        // Fund vault
        vm.startPrank(lp1);
        usdc.approve(address(vault), 50_000e6);
        vault.deposit(50_000e6, lp1);
        vm.stopPrank();

        // Agent spends up to daily limit
        for (uint256 i = 0; i < 4; i++) {
            bytes memory callData = abi.encodeCall(MockStrategy.execute, (5_000e6));
            vm.prank(agentPKP);
            vault.executeStrategy(address(strategy), callData, 5_000e6);
        }

        // Next tx should fail (20k daily limit, already spent 20k)
        bytes memory callData = abi.encodeCall(MockStrategy.execute, (1_000e6));
        vm.prank(agentPKP);
        vm.expectRevert("Exceeds agent daily limit");
        vault.executeStrategy(address(strategy), callData, 1_000e6);
    }

    function test_executeStrategy_dailyResets() public {
        // Fund vault
        vm.startPrank(lp1);
        usdc.approve(address(vault), 50_000e6);
        vault.deposit(50_000e6, lp1);
        vm.stopPrank();

        // Agent spends to daily limit
        for (uint256 i = 0; i < 4; i++) {
            bytes memory callData = abi.encodeCall(MockStrategy.execute, (5_000e6));
            vm.prank(agentPKP);
            vault.executeStrategy(address(strategy), callData, 5_000e6);
        }

        // Warp to next day
        vm.warp(block.timestamp + 1 days);

        // Should work again
        bytes memory callData = abi.encodeCall(MockStrategy.execute, (5_000e6));
        vm.prank(agentPKP);
        vault.executeStrategy(address(strategy), callData, 5_000e6);

        ISyndicateVault.AgentConfig memory config = vault.getAgentConfig(agentPKP);
        assertEq(config.spentToday, 5_000e6); // Reset to just this tx
    }

    function test_executeStrategy_notAgent_reverts() public {
        vm.prank(lp1);
        vm.expectRevert("Not an active agent");
        vault.executeStrategy(address(strategy), "", 1_000e6);
    }

    function test_executeStrategy_syndicateDailyLimit() public {
        // Register second agent with high limit
        vm.prank(owner);
        vault.registerAgent(agentPKP2, agentEOA2, MAX_PER_TX, MAX_DAILY);

        // Fund vault
        vm.startPrank(lp1);
        usdc.approve(address(vault), 100_000e6);
        vault.deposit(100_000e6, lp1);
        vm.stopPrank();

        // Agent 1 spends 20k
        for (uint256 i = 0; i < 4; i++) {
            bytes memory callData = abi.encodeCall(MockStrategy.execute, (5_000e6));
            vm.prank(agentPKP);
            vault.executeStrategy(address(strategy), callData, 5_000e6);
        }

        // Agent 2 spends 30k (up to 50k syndicate total)
        for (uint256 i = 0; i < 3; i++) {
            bytes memory callData = abi.encodeCall(MockStrategy.execute, (10_000e6));
            vm.prank(agentPKP2);
            vault.executeStrategy(address(strategy), callData, 10_000e6);
        }

        // Agent 2 tries one more — hits syndicate daily limit (50k)
        bytes memory callData = abi.encodeCall(MockStrategy.execute, (1_000e6));
        vm.prank(agentPKP2);
        vm.expectRevert("Exceeds syndicate daily limit");
        vault.executeStrategy(address(strategy), callData, 1_000e6);
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
}
