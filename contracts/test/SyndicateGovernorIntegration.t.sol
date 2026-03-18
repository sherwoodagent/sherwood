// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateGovernor} from "../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {ISyndicateVault} from "../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "./mocks/MockAgentRegistry.sol";
import {MockMToken} from "./mocks/MockMToken.sol";
import {MockComptroller} from "./mocks/MockComptroller.sol";

/**
 * @title SyndicateGovernorIntegrationTest
 * @notice Integration tests that exercise the full proposal lifecycle across
 *         governor + vault, including real DeFi mock interactions (Moonwell
 *         supply/borrow, unwind, P&L settlement).
 */
contract SyndicateGovernorIntegrationTest is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    ERC20Mock public targetToken;
    MockAgentRegistry public agentRegistry;
    MockMToken public mUsdc;
    MockComptroller public comptroller;

    address public owner = makeAddr("owner");
    address public agent = makeAddr("agent");
    address public agentEoa = makeAddr("agentEoa");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public random = makeAddr("random");

    uint256 public agentNftId;

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant QUORUM_BPS = 4000; // 40%
    uint256 constant MAX_PERF_FEE_BPS = 3000; // 30%
    uint256 constant MAX_STRATEGY_DURATION = 30 days;
    uint256 constant COOLDOWN_PERIOD = 1 days;

    function setUp() public {
        // Deploy tokens
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        targetToken = new ERC20Mock("Target", "TGT", 18);

        // Deploy DeFi mocks
        mUsdc = new MockMToken(address(usdc), "Moonwell USDC", "mUSDC");
        comptroller = new MockComptroller();

        // Deploy shared executor lib
        executorLib = new BatchExecutorLib();

        // Deploy ERC-8004 registry
        agentRegistry = new MockAgentRegistry();
        agentNftId = agentRegistry.mint(agentEoa);

        // Deploy vault
        SyndicateVault vaultImpl = new SyndicateVault();
        bytes memory vaultInit = abi.encodeCall(
            SyndicateVault.initialize,
            (ISyndicateVault.InitParams({
                    asset: address(usdc),
                    name: "Sherwood Vault",
                    symbol: "swUSDC",
                    owner: owner,
                    executorImpl: address(executorLib),
                    openDeposits: true,
                    agentRegistry: address(agentRegistry),
                    governor: address(0),
                    managementFeeBps: 0
                }))
        );
        vault = SyndicateVault(payable(address(new ERC1967Proxy(address(vaultImpl), vaultInit))));

        // Register agent
        vm.prank(owner);
        vault.registerAgent(agentNftId, agent, agentEoa);

        // Deploy governor
        SyndicateGovernor govImpl = new SyndicateGovernor();
        bytes memory govInit = abi.encodeCall(
            SyndicateGovernor.initialize,
            (
                owner,
                VOTING_PERIOD,
                EXECUTION_WINDOW,
                QUORUM_BPS,
                MAX_PERF_FEE_BPS,
                MAX_STRATEGY_DURATION,
                COOLDOWN_PERIOD
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        // Wire up
        vm.startPrank(owner);
        vault.setGovernor(address(governor));
        governor.addVault(address(vault));
        vm.stopPrank();

        // Fund LPs and deposit
        usdc.mint(lp1, 100_000e6);
        usdc.mint(lp2, 100_000e6);

        vm.startPrank(lp1);
        usdc.approve(address(vault), 60_000e6);
        vault.deposit(60_000e6, lp1);
        vm.stopPrank();

        vm.startPrank(lp2);
        usdc.approve(address(vault), 40_000e6);
        vault.deposit(40_000e6, lp2);
        vm.stopPrank();

        // Fund mToken with borrow liquidity
        usdc.mint(address(mUsdc), 1_000_000e6);

        // Mine a block so ERC20Votes checkpoints are queryable
        vm.warp(block.timestamp + 1);
    }

    // ── Helpers ──

    function _proposeVoteApprove(
        BatchExecutorLib.Call[] memory calls,
        uint256 splitIndex,
        uint256 feeBps,
        uint256 duration
    ) internal returns (uint256 proposalId) {
        vm.prank(agent);
        proposalId = governor.propose(address(vault), "ipfs://test", feeBps, duration, calls, splitIndex);

        // Mine a block so the snapshot block is in the past
        vm.warp(block.timestamp + 1);

        vm.prank(lp1);
        governor.vote(proposalId, true);
        vm.prank(lp2);
        governor.vote(proposalId, true);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
    }

    // ==================== FULL LIFECYCLE: PROPOSE → VOTE → EXECUTE → SETTLE ====================

    function test_fullLifecycle_proposeVoteExecuteSettle() public {
        // 1. Agent proposes: approve + revoke
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
        calls[1] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });

        vm.prank(agent);
        uint256 proposalId = governor.propose(address(vault), "ipfs://strategy1", 1500, 7 days, calls, 1);

        // Mine a block for checkpoint
        vm.warp(block.timestamp + 1);

        // 2. Shareholders vote
        vm.prank(lp1);
        governor.vote(proposalId, true);
        vm.prank(lp2);
        governor.vote(proposalId, true);

        // 3. Voting ends → Approved
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Approved));

        // 4. Anyone executes
        governor.executeProposal(proposalId);
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Executed));
        assertTrue(vault.redemptionsLocked());
        assertEq(usdc.allowance(address(vault), address(targetToken)), 50_000e6);

        // 5. Withdrawals blocked
        vm.prank(lp1);
        vm.expectRevert(ISyndicateVault.RedemptionsLocked.selector);
        vault.ragequit(lp1);

        // 6. Simulate profit
        usdc.mint(address(vault), 5_000e6);

        // 7. Duration passes, anyone settles
        vm.warp(block.timestamp + 7 days);
        uint256 agentBalBefore = usdc.balanceOf(agent);

        vm.prank(random);
        governor.settleProposal(proposalId);

        // 8. Verify settlement
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertFalse(vault.redemptionsLocked());
        assertEq(governor.getActiveProposal(address(vault)), 0);

        // Agent got 15% of 5k = 750 USDC
        assertEq(usdc.balanceOf(agent), agentBalBefore + 750e6);

        // Approval was revoked by settle calls
        assertEq(usdc.allowance(address(vault), address(targetToken)), 0);

        // 9. Cooldown → can withdraw
        vm.warp(governor.getCooldownEnd(address(vault)) + 1);
        vm.prank(lp1);
        vault.withdraw(10_000e6, lp1, lp1);
    }

    // ==================== REJECTED PROPOSAL ====================

    function test_fullLifecycle_rejectedProposal() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
        calls[1] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });

        vm.prank(agent);
        uint256 proposalId = governor.propose(address(vault), "ipfs://test", 1500, 7 days, calls, 1);

        // Mine a block for checkpoint
        vm.warp(block.timestamp + 1);

        // Majority votes against
        vm.prank(lp1);
        governor.vote(proposalId, false);
        vm.prank(lp2);
        governor.vote(proposalId, true);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Rejected));

        vm.expectRevert(ISyndicateGovernor.ProposalNotApproved.selector);
        governor.executeProposal(proposalId);
    }

    // ==================== EMERGENCY SETTLE WITH PROFIT ====================

    function test_fullLifecycle_emergencySettle() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
        calls[1] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });

        uint256 proposalId = _proposeVoteApprove(calls, 1, 1500, 7 days);
        governor.executeProposal(proposalId);

        // Simulate profit
        usdc.mint(address(vault), 3_000e6);

        // Warp past duration — emergency settle only available after duration
        vm.warp(block.timestamp + 7 days);

        // Owner emergency settles with custom unwind
        BatchExecutorLib.Call[] memory customCalls = new BatchExecutorLib.Call[](1);
        customCalls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });

        uint256 agentBalBefore = usdc.balanceOf(agent);

        vm.prank(owner);
        governor.emergencySettle(proposalId, customCalls);

        // Agent still gets fee: 15% of 3k = 450
        uint256 expectedFee = 3_000e6 * 1500 / 10000;
        assertEq(usdc.balanceOf(agent), agentBalBefore + expectedFee);
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertFalse(vault.redemptionsLocked());
    }

    // ==================== SEQUENTIAL STRATEGIES ====================

    function test_fullLifecycle_multipleProposalsSequential() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
        calls[1] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });

        // First strategy
        uint256 pid1 = _proposeVoteApprove(calls, 1, 1500, 3 days);
        governor.executeProposal(pid1);
        vm.warp(block.timestamp + 3 days);
        governor.settleProposal(pid1);

        // Cooldown
        vm.warp(block.timestamp + COOLDOWN_PERIOD + 1);

        // Second strategy
        uint256 pid2 = _proposeVoteApprove(calls, 1, 2000, 5 days);
        governor.executeProposal(pid2);
        vm.warp(block.timestamp + 5 days);
        governor.settleProposal(pid2);

        // Both settled
        assertEq(uint256(governor.getProposal(pid1).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertEq(uint256(governor.getProposal(pid2).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertEq(governor.getActiveProposal(address(vault)), 0);
        assertFalse(vault.redemptionsLocked());
    }

    // ==================== MOONWELL: REAL DEFI LIFECYCLE ====================

    function test_fullLifecycle_moonwellSupplyBorrowUnwind() public {
        // Strategy: supply USDC as collateral on Moonwell, borrow more USDC, then unwind

        uint256 supplyAmount = 50_000e6;
        uint256 borrowAmount = 25_000e6;

        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](7);

        // Execute: supply + borrow (4 calls)
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUsdc), supplyAmount)), value: 0
        });
        calls[1] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("mint(uint256)", supplyAmount), value: 0
        });
        address[] memory markets = new address[](1);
        markets[0] = address(mUsdc);
        calls[2] = BatchExecutorLib.Call({
            target: address(comptroller), data: abi.encodeCall(comptroller.enterMarkets, (markets)), value: 0
        });
        calls[3] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("borrow(uint256)", borrowAmount), value: 0
        });

        // Settle: approve → repay → redeem (3 calls)
        calls[4] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUsdc), borrowAmount)), value: 0
        });
        calls[5] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("repayBorrow(uint256)", borrowAmount), value: 0
        });
        calls[6] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("redeemUnderlying(uint256)", supplyAmount), value: 0
        });

        // splitIndex = 4 (first 4 are execute, last 3 are settle)
        uint256 proposalId = _proposeVoteApprove(calls, 4, 1500, 7 days);

        // Snapshot vault balance before execution
        uint256 vaultBalBefore = usdc.balanceOf(address(vault));
        assertEq(vaultBalBefore, 100_000e6);

        // Execute
        governor.executeProposal(proposalId);

        // Verify execution effects
        assertTrue(vault.redemptionsLocked());
        assertEq(mUsdc.balanceOf(address(vault)), supplyAmount); // vault holds mTokens
        // Vault balance: 100k - 50k supplied + 25k borrowed = 75k
        assertEq(usdc.balanceOf(address(vault)), 75_000e6);

        // Simulate time passing (strategy duration)
        vm.warp(block.timestamp + 7 days);

        // Settle — runs approve → repay → redeem
        vm.prank(random);
        governor.settleProposal(proposalId);

        // After settlement:
        // - Borrow repaid (25k)
        // - Collateral redeemed (50k back to USDC)
        // - Vault balance: 75k - 25k repaid + 50k redeemed = 100k (back to original)
        // - P&L = 100k - 100k = 0 (no profit, no loss)
        // - No fee

        assertEq(usdc.balanceOf(address(vault)), 100_000e6);
        assertEq(mUsdc.balanceOf(address(vault)), 0); // mTokens fully redeemed
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertFalse(vault.redemptionsLocked());
        assertEq(governor.getActiveProposal(address(vault)), 0);

        // Agent gets no fee (zero P&L)
        assertEq(usdc.balanceOf(agent), 0);
    }

    function test_fullLifecycle_moonwellFullUnwind_cleanSettlement() public {
        uint256 supplyAmount = 50_000e6;
        uint256 borrowAmount = 25_000e6;

        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](7);

        // Execute: supply + borrow (4 calls)
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUsdc), supplyAmount)), value: 0
        });
        calls[1] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("mint(uint256)", supplyAmount), value: 0
        });
        address[] memory markets = new address[](1);
        markets[0] = address(mUsdc);
        calls[2] = BatchExecutorLib.Call({
            target: address(comptroller), data: abi.encodeCall(comptroller.enterMarkets, (markets)), value: 0
        });
        calls[3] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("borrow(uint256)", borrowAmount), value: 0
        });

        // Settle: approve → repay → redeem (3 calls)
        calls[4] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUsdc), borrowAmount)), value: 0
        });
        calls[5] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("repayBorrow(uint256)", borrowAmount), value: 0
        });
        calls[6] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("redeemUnderlying(uint256)", supplyAmount), value: 0
        });

        // splitIndex = 4
        uint256 proposalId = _proposeVoteApprove(calls, 4, 2000, 7 days);

        governor.executeProposal(proposalId);

        // Verify mid-strategy state
        assertEq(usdc.balanceOf(address(vault)), 75_000e6); // 100k - 50k supplied + 25k borrowed
        assertEq(mUsdc.balanceOf(address(vault)), supplyAmount);

        vm.warp(block.timestamp + 7 days);

        // Anyone settles: repay 25k → redeem 50k → vault back to original
        vm.prank(random);
        governor.settleProposal(proposalId);

        assertEq(usdc.balanceOf(address(vault)), 100_000e6);
        assertEq(mUsdc.balanceOf(address(vault)), 0);
        assertEq(usdc.balanceOf(agent), 0);
        assertFalse(vault.redemptionsLocked());
    }
}
