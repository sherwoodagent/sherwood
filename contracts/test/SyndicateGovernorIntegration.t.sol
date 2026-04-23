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
import {MockRegistryMinimal} from "./mocks/MockRegistryMinimal.sol";

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
    MockRegistryMinimal public guardianRegistry;

    address public owner = makeAddr("owner");
    address public agent = makeAddr("agent");
    address public agentEoa = makeAddr("agentEoa");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public random = makeAddr("random");

    uint256 public agentNftId;

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant MAX_STRATEGY_DURATION = 30 days;
    uint256 constant COOLDOWN_PERIOD = 1 days;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        targetToken = new ERC20Mock("Target", "TGT", 18);
        mUsdc = new MockMToken(address(usdc), "Moonwell USDC", "mUSDC");
        comptroller = new MockComptroller();
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();
        guardianRegistry = new MockRegistryMinimal();
        agentNftId = agentRegistry.mint(agent);

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
                    managementFeeBps: 0
                }))
        );
        vault = SyndicateVault(payable(address(new ERC1967Proxy(address(vaultImpl), vaultInit))));

        vm.prank(owner);
        vault.registerAgent(agentNftId, agent);

        SyndicateGovernor govImpl = new SyndicateGovernor();
        bytes memory govInit = abi.encodeCall(
            SyndicateGovernor.initialize,
            (
                ISyndicateGovernor.InitParams({
                    owner: owner,
                    votingPeriod: VOTING_PERIOD,
                    executionWindow: EXECUTION_WINDOW,
                    vetoThresholdBps: VETO_THRESHOLD_BPS,
                    maxPerformanceFeeBps: MAX_PERF_FEE_BPS,
                    cooldownPeriod: COOLDOWN_PERIOD,
                    collaborationWindow: 48 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 hours,
                    maxStrategyDuration: MAX_STRATEGY_DURATION,
                    protocolFeeBps: 200,
                    protocolFeeRecipient: owner,
                    guardianFeeBps: 0
                }),
                address(guardianRegistry)
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(address(governor)));
        vm.prank(owner);
        governor.addVault(address(vault));

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

        usdc.mint(address(mUsdc), 1_000_000e6);
        vm.warp(block.timestamp + 1);
    }

    // ── Helpers ──

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }

    function _proposeVoteApprove(
        BatchExecutorLib.Call[] memory executeCalls,
        BatchExecutorLib.Call[] memory settlementCalls,
        uint256 feeBps,
        uint256 duration
    ) internal returns (uint256 proposalId) {
        vm.prank(agent);
        proposalId = governor.propose(
            address(vault), "ipfs://test", feeBps, duration, executeCalls, settlementCalls, _emptyCoProposers()
        );
        // via_ir-safe: use vm.getBlockTimestamp() so the IR optimizer can't reorder
        // block.timestamp reads across vm.warp cheatcodes
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
    }

    // ==================== FULL LIFECYCLE: PROPOSE -> VOTE -> EXECUTE -> SETTLE ====================

    function test_fullLifecycle_proposeVoteExecuteSettle() public {
        BatchExecutorLib.Call[] memory execCalls = new BatchExecutorLib.Call[](1);
        execCalls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });

        BatchExecutorLib.Call[] memory settleCalls = new BatchExecutorLib.Call[](1);
        settleCalls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });

        uint256 proposalId = _proposeVoteApprove(execCalls, settleCalls, 1500, 7 days);

        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Approved));

        governor.executeProposal(proposalId);
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Executed));
        assertTrue(vault.redemptionsLocked());
        assertEq(usdc.allowance(address(vault), address(targetToken)), 50_000e6);

        vm.prank(lp1);
        vm.expectRevert(ISyndicateVault.RedemptionsLocked.selector);
        vault.withdraw(1_000e6, lp1, lp1);

        usdc.mint(address(vault), 5_000e6);

        vm.warp(block.timestamp + 7 days);
        uint256 agentBalBefore = usdc.balanceOf(agent);
        vm.prank(random);
        governor.settleProposal(proposalId);

        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertFalse(vault.redemptionsLocked());
        assertEq(governor.getActiveProposal(address(vault)), 0);

        // Protocol fee: 2% of 5k = 100. Agent got 15% of (5k - 100) = 15% of 4,900 = 735 USDC
        assertEq(usdc.balanceOf(agent), agentBalBefore + 735e6);
        assertEq(usdc.allowance(address(vault), address(targetToken)), 0);

        vm.warp(governor.getCooldownEnd(address(vault)) + 1);
        vm.prank(lp1);
        vault.withdraw(10_000e6, lp1, lp1);
    }

    // ==================== REJECTED PROPOSAL ====================

    function test_fullLifecycle_rejectedProposal() public {
        BatchExecutorLib.Call[] memory execCalls = new BatchExecutorLib.Call[](1);
        execCalls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });

        BatchExecutorLib.Call[] memory settleCalls = new BatchExecutorLib.Call[](1);
        settleCalls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });

        vm.prank(agent);
        uint256 proposalId =
            governor.propose(address(vault), "ipfs://test", 1500, 7 days, execCalls, settleCalls, _emptyCoProposers());
        vm.warp(block.timestamp + 1);

        // Both vote against -- triggers veto threshold
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Against);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Against);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Rejected));
        vm.expectRevert(ISyndicateGovernor.ProposalNotApproved.selector);
        governor.executeProposal(proposalId);
    }

    // The old `emergencySettle(uint256, Call[])` integration scenario was replaced
    // by the Task 24 guardian-review lifecycle. See
    // `test/governor/GovernorEmergency.t.sol` for full-lifecycle tests of
    // unstick / emergencySettleWithCalls / cancel / finalize.

    // ==================== SEQUENTIAL STRATEGIES ====================

    function test_fullLifecycle_multipleProposalsSequential() public {
        BatchExecutorLib.Call[] memory execCalls = new BatchExecutorLib.Call[](1);
        execCalls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });

        BatchExecutorLib.Call[] memory settleCalls = new BatchExecutorLib.Call[](1);
        settleCalls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });

        uint256 pid1 = _proposeVoteApprove(execCalls, settleCalls, 1500, 3 days);
        governor.executeProposal(pid1);
        vm.warp(block.timestamp + 3 days);
        governor.settleProposal(pid1);
        vm.warp(block.timestamp + COOLDOWN_PERIOD + 1);

        uint256 pid2 = _proposeVoteApprove(execCalls, settleCalls, 2000, 5 days);
        governor.executeProposal(pid2);
        vm.warp(block.timestamp + 5 days);
        governor.settleProposal(pid2);

        assertEq(uint256(governor.getProposal(pid1).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertEq(uint256(governor.getProposal(pid2).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertEq(governor.getActiveProposal(address(vault)), 0);
        assertFalse(vault.redemptionsLocked());
    }

    // ==================== MOONWELL: REAL DEFI LIFECYCLE ====================

    function test_fullLifecycle_moonwellSupplyBorrowUnwind() public {
        uint256 supplyAmount = 50_000e6;
        uint256 borrowAmount = 25_000e6;

        // Execute calls: approve + supply + enter markets + borrow
        BatchExecutorLib.Call[] memory execCalls = new BatchExecutorLib.Call[](4);
        execCalls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUsdc), supplyAmount)), value: 0
        });
        execCalls[1] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("mint(uint256)", supplyAmount), value: 0
        });
        address[] memory markets = new address[](1);
        markets[0] = address(mUsdc);
        execCalls[2] = BatchExecutorLib.Call({
            target: address(comptroller), data: abi.encodeCall(comptroller.enterMarkets, (markets)), value: 0
        });
        execCalls[3] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("borrow(uint256)", borrowAmount), value: 0
        });

        // Settlement calls: approve + repay + redeem
        BatchExecutorLib.Call[] memory settleCalls = new BatchExecutorLib.Call[](3);
        settleCalls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(mUsdc), borrowAmount)), value: 0
        });
        settleCalls[1] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("repayBorrow(uint256)", borrowAmount), value: 0
        });
        settleCalls[2] = BatchExecutorLib.Call({
            target: address(mUsdc), data: abi.encodeWithSignature("redeemUnderlying(uint256)", supplyAmount), value: 0
        });

        uint256 proposalId = _proposeVoteApprove(execCalls, settleCalls, 1500, 7 days);

        uint256 vaultBalBefore = usdc.balanceOf(address(vault));
        assertEq(vaultBalBefore, 100_000e6);

        governor.executeProposal(proposalId);

        assertTrue(vault.redemptionsLocked());
        assertEq(mUsdc.balanceOf(address(vault)), supplyAmount);
        assertEq(usdc.balanceOf(address(vault)), 75_000e6);

        vm.warp(block.timestamp + 7 days);

        vm.prank(random);
        governor.settleProposal(proposalId);

        assertEq(usdc.balanceOf(address(vault)), 100_000e6);
        assertEq(mUsdc.balanceOf(address(vault)), 0);
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertFalse(vault.redemptionsLocked());
        assertEq(governor.getActiveProposal(address(vault)), 0);
        assertEq(usdc.balanceOf(agent), 0);
    }
}
