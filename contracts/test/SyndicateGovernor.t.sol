// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateGovernor} from "../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {ISyndicateVault} from "../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "./mocks/MockAgentRegistry.sol";

contract AssertActiveProposalOnExecute {
    function assertActive(address governor, address vault, uint256 proposalId) external view {
        uint256 active = ISyndicateGovernor(governor).getActiveProposal(vault);
        require(active == proposalId, "active proposal not set");
    }
}

contract RevertingTarget {
    function fail() external pure {
        revert("expected revert");
    }
}

contract SyndicateGovernorTest is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    MockAgentRegistry public agentRegistry;

    address public owner = makeAddr("owner");
    address public agent = makeAddr("agent");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public random = makeAddr("random");

    uint256 public agentNftId;

    // Governor params
    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant QUORUM_BPS = 4000; // 40%
    uint256 constant MAX_PERF_FEE_BPS = 3000; // 30%
    uint256 constant COOLDOWN_PERIOD = 1 days;

    // ── A simple target contract for testing batch execution ──
    ERC20Mock public targetToken;
    AssertActiveProposalOnExecute public activeAssertTarget;
    RevertingTarget public revertingTarget;

    function setUp() public {
        // Deploy tokens
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        targetToken = new ERC20Mock("Target", "TGT", 18);
        activeAssertTarget = new AssertActiveProposalOnExecute();
        revertingTarget = new RevertingTarget();

        // Deploy shared executor lib
        executorLib = new BatchExecutorLib();

        // Deploy ERC-8004 registry
        agentRegistry = new MockAgentRegistry();
        agentNftId = agentRegistry.mint(agent);

        // Deploy governor first (vault requires governor at init)
        SyndicateGovernor govImpl = new SyndicateGovernor();
        bytes memory govInit = abi.encodeCall(
            SyndicateGovernor.initialize,
            (ISyndicateGovernor.InitParams({
                    owner: owner,
                    votingPeriod: VOTING_PERIOD,
                    executionWindow: EXECUTION_WINDOW,
                    quorumBps: QUORUM_BPS,
                    maxPerformanceFeeBps: MAX_PERF_FEE_BPS,
                    cooldownPeriod: COOLDOWN_PERIOD,
                    collaborationWindow: 48 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 days,
                    maxStrategyDuration: 7 days
                }))
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        // Deploy vault with governor set
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
                    governor: address(governor),
                    managementFeeBps: 50
                }))
        );
        vault = SyndicateVault(payable(address(new ERC1967Proxy(address(vaultImpl), vaultInit))));

        // Register agent on vault
        vm.prank(owner);
        vault.registerAgent(agentNftId, agent);

        // Register vault on governor
        vm.prank(owner);
        governor.addVault(address(vault));

        // Fund LPs
        usdc.mint(lp1, 100_000e6);
        usdc.mint(lp2, 100_000e6);

        // LP1 deposits 60k, LP2 deposits 40k
        vm.startPrank(lp1);
        usdc.approve(address(vault), 60_000e6);
        vault.deposit(60_000e6, lp1);
        vm.stopPrank();

        vm.startPrank(lp2);
        usdc.approve(address(vault), 40_000e6);
        vault.deposit(40_000e6, lp2);
        vm.stopPrank();

        // Mine a block so ERC20Votes checkpoints are queryable
        vm.warp(block.timestamp + 1);
    }

    // ==================== HELPERS ====================

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }

    function _defaultInitParams() internal view returns (ISyndicateGovernor.InitParams memory) {
        return ISyndicateGovernor.InitParams({
            owner: owner,
            votingPeriod: VOTING_PERIOD,
            executionWindow: EXECUTION_WINDOW,
            quorumBps: QUORUM_BPS,
            maxPerformanceFeeBps: MAX_PERF_FEE_BPS,
            cooldownPeriod: COOLDOWN_PERIOD,
            collaborationWindow: 48 hours,
            maxCoProposers: 5,
            minStrategyDuration: 1 days,
            maxStrategyDuration: 7 days
        });
    }

    /// @dev Create a simple proposal: "approve USDC to target" as execute, "approve 0" as settle
    function _createSimpleProposal(uint256 perfFeeBps, uint256 duration)
        internal
        returns (uint256 proposalId, BatchExecutorLib.Call[] memory calls)
    {
        calls = new BatchExecutorLib.Call[](2);
        // Execute call: approve targetToken to spend vault's USDC
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
        // Settle call: revoke approval
        calls[1] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });

        vm.prank(agent);
        proposalId =
            governor.propose(address(vault), "ipfs://test", perfFeeBps, duration, calls, 1, _emptyCoProposers());

        // Mine a block so the snapshot block is in the past for voting
        vm.warp(block.timestamp + 1);
    }

    /// @dev Create proposal, vote it through, and return proposal ID
    function _createApprovedProposal(uint256 perfFeeBps, uint256 duration) internal returns (uint256 proposalId) {
        (proposalId,) = _createSimpleProposal(perfFeeBps, duration);

        // Both LPs vote FOR
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        // Warp past voting period
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
    }

    /// @dev Full lifecycle up to execution
    function _createAndExecuteProposal(uint256 perfFeeBps, uint256 duration) internal returns (uint256 proposalId) {
        proposalId = _createApprovedProposal(perfFeeBps, duration);
        governor.executeProposal(proposalId);
    }

    /// @dev Build the settle calls matching the simple proposal
    function _simpleSettleCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });
        return calls;
    }

    // ==================== INITIALIZATION ====================

    function test_initialize() public view {
        ISyndicateGovernor.GovernorParams memory params = governor.getGovernorParams();
        assertEq(params.votingPeriod, VOTING_PERIOD);
        assertEq(params.executionWindow, EXECUTION_WINDOW);
        assertEq(params.quorumBps, QUORUM_BPS);
        assertEq(params.maxPerformanceFeeBps, MAX_PERF_FEE_BPS);
        assertEq(params.cooldownPeriod, COOLDOWN_PERIOD);
        assertEq(governor.getGovernorParams().minStrategyDuration, 1 days);
        assertEq(governor.getGovernorParams().maxStrategyDuration, 7 days);
        assertEq(governor.proposalCount(), 0);
        assertTrue(governor.isRegisteredVault(address(vault)));
    }

    function test_initialize_zeroOwner_reverts() public {
        SyndicateGovernor govImpl = new SyndicateGovernor();
        ISyndicateGovernor.InitParams memory p = _defaultInitParams();
        p.owner = address(0);

        bytes memory initData = abi.encodeCall(SyndicateGovernor.initialize, (p));
        vm.expectRevert(ISyndicateGovernor.ZeroAddress.selector);
        new ERC1967Proxy(address(govImpl), initData);
    }

    function test_initialize_invalidStrategyDurationBounds_reverts() public {
        SyndicateGovernor govImpl = new SyndicateGovernor();
        ISyndicateGovernor.InitParams memory p = _defaultInitParams();
        p.minStrategyDuration = 8 days;
        p.maxStrategyDuration = 7 days;

        bytes memory initData = abi.encodeCall(SyndicateGovernor.initialize, (p));
        vm.expectRevert(ISyndicateGovernor.InvalidStrategyDurationBounds.selector);
        new ERC1967Proxy(address(govImpl), initData);
    }

    function test_initialize_invalidCollaborationWindow_reverts() public {
        SyndicateGovernor govImpl = new SyndicateGovernor();
        ISyndicateGovernor.InitParams memory p = _defaultInitParams();
        p.collaborationWindow = 30 minutes;

        bytes memory initData = abi.encodeCall(SyndicateGovernor.initialize, (p));
        vm.expectRevert(ISyndicateGovernor.InvalidCollaborationWindow.selector);
        new ERC1967Proxy(address(govImpl), initData);
    }

    function test_initialize_invalidMaxCoProposers_reverts() public {
        SyndicateGovernor govImpl = new SyndicateGovernor();
        ISyndicateGovernor.InitParams memory p = _defaultInitParams();
        p.maxCoProposers = 0;

        bytes memory initData = abi.encodeCall(SyndicateGovernor.initialize, (p));
        vm.expectRevert(ISyndicateGovernor.InvalidMaxCoProposers.selector);
        new ERC1967Proxy(address(govImpl), initData);
    }

    // ==================== PROPOSE ====================

    function test_propose() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        assertEq(proposalId, 1);
        assertEq(governor.proposalCount(), 1);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(p.proposer, agent);
        assertEq(p.vault, address(vault));
        assertEq(p.performanceFeeBps, 1500);
        assertEq(p.strategyDuration, 7 days);
        assertEq(p.splitIndex, 1);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Pending));

        BatchExecutorLib.Call[] memory calls = governor.getProposalCalls(proposalId);
        assertEq(calls.length, 2);
    }

    function test_propose_notRegisteredAgent_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});
        calls[1] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});

        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotRegisteredAgent.selector);
        governor.propose(address(vault), "ipfs://test", 1500, 7 days, calls, 1, _emptyCoProposers());
    }

    function test_propose_vaultNotRegistered_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});
        calls[1] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.VaultNotRegistered.selector);
        governor.propose(makeAddr("fakeVault"), "ipfs://test", 1500, 7 days, calls, 1, _emptyCoProposers());
    }

    function test_propose_performanceFeeTooHigh_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});
        calls[1] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.PerformanceFeeTooHigh.selector);
        governor.propose(address(vault), "ipfs://test", MAX_PERF_FEE_BPS + 1, 7 days, calls, 1, _emptyCoProposers());
    }

    function test_propose_strategyDurationTooLong_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});
        calls[1] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.StrategyDurationTooLong.selector);
        governor.propose(address(vault), "ipfs://test", 1500, 8 days, calls, 1, _emptyCoProposers());
    }

    function test_propose_strategyDurationTooShort_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});
        calls[1] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.StrategyDurationTooShort.selector);
        governor.propose(address(vault), "ipfs://test", 1500, 12 hours, calls, 1, _emptyCoProposers());
    }

    function test_propose_invalidSplitIndex_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});
        calls[1] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});

        // splitIndex = 0 (no execute calls)
        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.InvalidSplitIndex.selector);
        governor.propose(address(vault), "ipfs://test", 1500, 7 days, calls, 0, _emptyCoProposers());

        // splitIndex = calls.length (no settle calls)
        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.InvalidSplitIndex.selector);
        governor.propose(address(vault), "ipfs://test", 1500, 7 days, calls, 2, _emptyCoProposers());
    }

    function test_propose_emptyCalls_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.EmptyCalls.selector);
        governor.propose(address(vault), "ipfs://test", 1500, 7 days, calls, 1, _emptyCoProposers());
    }

    // ==================== VOTING ====================

    function test_vote() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Against);

        assertTrue(governor.hasVoted(proposalId, lp1));
        assertTrue(governor.hasVoted(proposalId, lp2));
        assertFalse(governor.hasVoted(proposalId, random));

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(p.votesFor, vault.balanceOf(lp1));
        assertEq(p.votesAgainst, vault.balanceOf(lp2));
    }

    function test_vote_doubleVote_reverts() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        vm.prank(lp1);
        vm.expectRevert(ISyndicateGovernor.AlreadyVoted.selector);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
    }

    function test_vote_noShares_reverts() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NoVotingPower.selector);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
    }

    function test_vote_afterVotingPeriod_reverts() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        vm.prank(lp1);
        vm.expectRevert(ISyndicateGovernor.NotWithinVotingPeriod.selector);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
    }

    function test_vote_snapshotPreventsTransferVoting() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        // LP1 votes first
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        uint256 lp1Weight = governor.getVoteWeight(proposalId, lp1);
        assertEq(lp1Weight, vault.balanceOf(lp1));

        // LP1 transfers shares to random after voting
        uint256 lp1Shares = vault.balanceOf(lp1);
        vm.prank(lp1);
        vault.transfer(random, lp1Shares);

        // LP1 can't vote again even though they transferred
        vm.prank(lp1);
        vm.expectRevert(ISyndicateGovernor.AlreadyVoted.selector);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        // Random cannot vote because they had no balance at snapshot block
        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NoVotingPower.selector);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Against);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(p.votesFor, lp1Weight); // LP1's original balance
        assertEq(p.votesAgainst, 0); // Random couldn't vote
    }

    // ==================== PROPOSAL STATE RESOLUTION ====================

    function test_proposalState_approved() public {
        uint256 proposalId = _createApprovedProposal(1500, 7 days);
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Approved));
    }

    function test_proposalState_rejected_noQuorum() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        // No votes at all — warp past voting period
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Rejected));
    }

    function test_proposalState_rejected_majorityAgainst() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Against); // 60k against
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For); // 40k for

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Rejected));
    }

    function test_proposalState_rejected_abstainOnly() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        // Both LPs abstain — meets quorum but votesFor (0) <= votesAgainst (0) → rejected
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Abstain);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Abstain);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Rejected));
    }

    function test_proposalState_expired() public {
        uint256 proposalId = _createApprovedProposal(1500, 7 days);

        // Warp past execution window
        vm.warp(block.timestamp + EXECUTION_WINDOW + 1);

        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Expired));
    }

    // ==================== EXECUTE ====================

    function test_executeProposal() public {
        uint256 proposalId = _createApprovedProposal(1500, 7 days);

        governor.executeProposal(proposalId);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Executed));
        assertEq(governor.getActiveProposal(address(vault)), proposalId);
        assertTrue(vault.redemptionsLocked());
        assertEq(governor.getCapitalSnapshot(proposalId), 100_000e6); // 60k + 40k
    }

    function test_executeProposal_setsActiveBeforeExternalCalls() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({
            target: address(activeAssertTarget),
            data: abi.encodeCall(activeAssertTarget.assertActive, (address(governor), address(vault), 1)),
            value: 0
        });
        calls[1] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });

        vm.prank(agent);
        uint256 proposalId =
            governor.propose(address(vault), "ipfs://test", 1500, 7 days, calls, 1, _emptyCoProposers());
        vm.warp(block.timestamp + 1);

        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        governor.executeProposal(proposalId);
        assertEq(governor.getActiveProposal(address(vault)), proposalId);
    }

    function test_executeProposal_notApproved_reverts() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        // Don't vote, just warp — should be rejected
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        vm.expectRevert(ISyndicateGovernor.ProposalNotApproved.selector);
        governor.executeProposal(proposalId);
    }

    function test_executeProposal_executionWindowExpired_reverts() public {
        // Create proposal and vote it through
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        // Warp past voting period
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        // Resolve to Approved
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Approved));

        // Now warp past execution window from the original proposal creation
        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        vm.warp(p.executeBy + 1);

        // Should be Expired now
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Expired));
    }

    function test_executeProposal_strategyAlreadyActive_reverts() public {
        // Execute first proposal
        _createAndExecuteProposal(1500, 7 days);

        // Try to execute a second
        uint256 proposalId2 = _createApprovedProposal(1500, 7 days);

        vm.expectRevert(ISyndicateGovernor.StrategyAlreadyActive.selector);
        governor.executeProposal(proposalId2);
    }

    function test_executeProposal_cooldownNotElapsed_reverts() public {
        // Use a longer cooldown to ensure the test works
        vm.prank(owner);
        governor.setCooldownPeriod(3 days);

        // Execute and settle first proposal (agent settles early)
        uint256 proposalId1 = _createAndExecuteProposal(1500, 7 days);
        vm.prank(agent);
        governor.settleByAgent(proposalId1, _simpleSettleCalls());

        // Create second proposal and vote immediately
        (uint256 proposalId2,) = _createSimpleProposal(1500, 7 days);
        vm.prank(lp1);
        governor.vote(proposalId2, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId2, ISyndicateGovernor.VoteType.For);

        // Warp past voting period (1 day) — but cooldown is 3 days from settlement
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        // Should fail — only ~1 day since settlement, cooldown is 3 days
        vm.expectRevert(ISyndicateGovernor.CooldownNotElapsed.selector);
        governor.executeProposal(proposalId2);
    }

    function test_executeProposal_afterCooldown_succeeds() public {
        // Execute and settle first proposal (agent settles early)
        uint256 proposalId1 = _createAndExecuteProposal(1500, 7 days);
        vm.prank(agent);
        governor.settleByAgent(proposalId1, _simpleSettleCalls());

        // Warp past cooldown
        vm.warp(block.timestamp + COOLDOWN_PERIOD + 1);

        // Create, approve and execute second proposal
        uint256 proposalId2 = _createApprovedProposal(1500, 7 days);
        governor.executeProposal(proposalId2);

        assertEq(governor.getActiveProposal(address(vault)), proposalId2);
    }

    // ==================== SETTLEMENT ====================

    // ── Path 1: Agent settle ──

    function test_settleByAgent() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        // Agent can settle early with custom calls
        vm.prank(agent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertEq(governor.getActiveProposal(address(vault)), 0);
        assertFalse(vault.redemptionsLocked());
    }

    function test_settleByAgent_notProposer_reverts() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotProposer.selector);
        governor.settleByAgent(proposalId, _simpleSettleCalls());
    }

    function test_settleByAgent_precommittedFailWithoutFallback_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
        calls[1] = BatchExecutorLib.Call({
            target: address(revertingTarget), data: abi.encodeCall(revertingTarget.fail, ()), value: 0
        });

        vm.prank(agent);
        uint256 proposalId =
            governor.propose(address(vault), "ipfs://test", 1500, 7 days, calls, 1, _emptyCoProposers());
        vm.warp(block.timestamp + 1);

        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        governor.executeProposal(proposalId);
        vm.warp(block.timestamp + 7 days);

        vm.prank(agent);
        vm.expectRevert(bytes("expected revert"));
        governor.settleByAgent(proposalId, new BatchExecutorLib.Call[](0));

        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Executed));
    }

    function test_settleByAgent_causedLoss_reverts() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        // Simulate loss: burn USDC from vault
        usdc.burn(address(vault), 5_000e6);

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.SettlementCausedLoss.selector);
        governor.settleByAgent(proposalId, _simpleSettleCalls());
    }

    // ── Path 2: Permissionless settle ──

    function test_settleProposal_permissionless_afterDuration() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        // Warp past strategy duration
        vm.warp(block.timestamp + 7 days);

        // Anyone can settle
        vm.prank(random);
        governor.settleProposal(proposalId);

        assertEq(uint256(governor.getProposal(proposalId).state), uint256(ISyndicateGovernor.ProposalState.Settled));
    }

    function test_settleProposal_beforeDuration_reverts() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.StrategyDurationNotElapsed.selector);
        governor.settleProposal(proposalId);
    }

    function test_settleProposal_notExecuted_reverts() public {
        uint256 proposalId = _createApprovedProposal(1500, 7 days);

        vm.expectRevert(ISyndicateGovernor.ProposalNotExecuted.selector);
        governor.settleProposal(proposalId);
    }

    // ── Path 3: Emergency settle (vault owner) ──

    function test_emergencySettle_afterDuration() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        vm.warp(block.timestamp + 7 days);

        vm.prank(owner);
        governor.emergencySettle(proposalId, _simpleSettleCalls());

        assertEq(uint256(governor.getProposal(proposalId).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertFalse(vault.redemptionsLocked());
        assertEq(governor.getActiveProposal(address(vault)), 0);
    }

    function test_emergencySettle_beforeDuration_reverts() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.StrategyDurationNotElapsed.selector);
        governor.emergencySettle(proposalId, _simpleSettleCalls());
    }

    // ==================== P&L CALCULATION ====================

    function test_settlement_noProfit_noFee() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        uint256 agentBalBefore = usdc.balanceOf(agent);

        // Agent settles (no profit, no loss)
        vm.prank(agent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        // No profit = no fee
        assertEq(usdc.balanceOf(agent), agentBalBefore);
    }

    function test_settlement_withProfit_agentAndManagementFee() public {
        // Management fee is 50 bps (0.5%) — set at vault init
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        // Simulate profit
        usdc.mint(address(vault), 10_000e6);

        uint256 agentBalBefore = usdc.balanceOf(agent);
        uint256 ownerBalBefore = usdc.balanceOf(owner);

        // Agent settles with profit
        vm.prank(agent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        // Agent fee: 15% of 10k = 1,500
        // Management fee: 0.5% of (10k - 1,500) = 0.5% of 8,500 = 42.5 → 42 (truncated)
        assertEq(usdc.balanceOf(agent), agentBalBefore + 1_500e6);
        assertEq(usdc.balanceOf(owner), ownerBalBefore + 42_500000);
    }

    function test_settlement_withLoss_permissionlessPath() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        // Simulate loss
        usdc.burn(address(vault), 5_000e6);

        // Agent can't settle (would revert with SettlementCausedLoss)
        // Warp past duration for permissionless path
        vm.warp(block.timestamp + 7 days);

        uint256 agentBalBefore = usdc.balanceOf(agent);

        vm.prank(random);
        governor.settleProposal(proposalId);

        // Loss = no fee
        assertEq(usdc.balanceOf(agent), agentBalBefore);
    }

    // ==================== REDEMPTION LOCK ====================

    function test_redemptionLock_withdrawReverts() public {
        _createAndExecuteProposal(1500, 7 days);

        vm.prank(lp1);
        vm.expectRevert(ISyndicateVault.RedemptionsLocked.selector);
        vault.withdraw(1_000e6, lp1, lp1);
    }

    function test_redemptionLock_redeemReverts() public {
        _createAndExecuteProposal(1500, 7 days);

        vm.prank(lp1);
        vm.expectRevert(ISyndicateVault.RedemptionsLocked.selector);
        vault.redeem(1_000e6, lp1, lp1);
    }

    function test_redemptionLock_ragequitReverts() public {
        _createAndExecuteProposal(1500, 7 days);

        vm.prank(lp1);
        vm.expectRevert(ISyndicateVault.RedemptionsLocked.selector);
        vault.ragequit(lp1);
    }

    function test_redemptionLock_depositStillWorks() public {
        _createAndExecuteProposal(1500, 7 days);

        // Deposits should still work during live strategy
        usdc.mint(random, 10_000e6);
        vm.startPrank(random);
        usdc.approve(address(vault), 10_000e6);
        uint256 shares = vault.deposit(10_000e6, random);
        vm.stopPrank();

        assertGt(shares, 0);
    }

    function test_redemptionUnlocked_afterSettlement() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        // Agent settles
        vm.prank(agent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        // Now LP can withdraw
        vm.prank(lp1);
        uint256 assets = vault.withdraw(1_000e6, lp1, lp1);
        assertEq(assets, 1_000e6);
    }

    // ==================== CANCEL ====================

    function test_cancelProposal() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        vm.prank(agent);
        governor.cancelProposal(proposalId);

        assertEq(uint256(governor.getProposal(proposalId).state), uint256(ISyndicateGovernor.ProposalState.Cancelled));
    }

    function test_cancelProposal_notProposer_reverts() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotProposer.selector);
        governor.cancelProposal(proposalId);
    }

    function test_cancelProposal_afterVoting_reverts() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.ProposalNotCancellable.selector);
        governor.cancelProposal(proposalId);
    }

    function test_emergencyCancel() public {
        uint256 proposalId = _createApprovedProposal(1500, 7 days);

        vm.prank(owner);
        governor.emergencyCancel(proposalId);

        assertEq(uint256(governor.getProposal(proposalId).state), uint256(ISyndicateGovernor.ProposalState.Cancelled));
    }

    function test_emergencyCancel_notVaultOwner_reverts() public {
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotVaultOwner.selector);
        governor.emergencyCancel(proposalId);
    }

    function test_emergencyCancel_executedProposal_reverts() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.ProposalNotCancellable.selector);
        governor.emergencyCancel(proposalId);
    }

    function test_emergencySettle_notVaultOwner_reverts() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);

        vm.warp(block.timestamp + 7 days);

        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotVaultOwner.selector);
        governor.emergencySettle(proposalId, _simpleSettleCalls());
    }

    // ==================== PARAMETER SETTERS ====================

    function test_setVotingPeriod() public {
        vm.prank(owner);
        governor.setVotingPeriod(2 days);

        assertEq(governor.getGovernorParams().votingPeriod, 2 days);
    }

    function test_setVotingPeriod_tooLow_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.InvalidVotingPeriod.selector);
        governor.setVotingPeriod(30 minutes);
    }

    function test_setVotingPeriod_tooHigh_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.InvalidVotingPeriod.selector);
        governor.setVotingPeriod(31 days);
    }

    function test_setExecutionWindow() public {
        vm.prank(owner);
        governor.setExecutionWindow(2 days);

        assertEq(governor.getGovernorParams().executionWindow, 2 days);
    }

    function test_setQuorumBps() public {
        vm.prank(owner);
        governor.setQuorumBps(5000);

        assertEq(governor.getGovernorParams().quorumBps, 5000);
    }

    function test_setMaxPerformanceFeeBps() public {
        vm.prank(owner);
        governor.setMaxPerformanceFeeBps(2000);

        assertEq(governor.getGovernorParams().maxPerformanceFeeBps, 2000);
    }

    function test_setMaxStrategyDuration() public {
        vm.prank(owner);
        governor.setMaxStrategyDuration(14 days);

        assertEq(governor.getGovernorParams().maxStrategyDuration, 14 days);
    }

    function test_setMinStrategyDuration() public {
        vm.prank(owner);
        governor.setMinStrategyDuration(2 hours);

        assertEq(governor.getGovernorParams().minStrategyDuration, 2 hours);
    }

    function test_setCooldownPeriod() public {
        vm.prank(owner);
        governor.setCooldownPeriod(2 days);

        assertEq(governor.getGovernorParams().cooldownPeriod, 2 days);
    }

    function test_setters_notOwner_reverts() public {
        vm.startPrank(random);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, random));
        governor.setVotingPeriod(2 days);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, random));
        governor.setExecutionWindow(2 days);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, random));
        governor.setQuorumBps(5000);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, random));
        governor.setMaxPerformanceFeeBps(2000);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, random));
        governor.setMaxStrategyDuration(14 days);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, random));
        governor.setMinStrategyDuration(2 hours);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, random));
        governor.setCooldownPeriod(2 days);
        vm.stopPrank();
    }

    // ==================== VAULT MANAGEMENT ====================

    function test_addVault() public {
        address newVault = makeAddr("newVault");
        vm.prank(owner);
        governor.addVault(newVault);
        assertTrue(governor.isRegisteredVault(newVault));
    }

    function test_addVault_duplicate_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.VaultAlreadyRegistered.selector);
        governor.addVault(address(vault));
    }

    function test_addVault_notAuthorized_reverts() public {
        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotAuthorized.selector);
        governor.addVault(makeAddr("newVault"));
    }

    function test_addVault_factoryAuthorized_succeeds() public {
        address factory_ = makeAddr("factory");
        address newVault = makeAddr("newVault");

        vm.prank(owner);
        governor.setFactory(factory_);

        vm.prank(factory_);
        governor.addVault(newVault);

        assertTrue(governor.isRegisteredVault(newVault));
    }

    function test_removeVault() public {
        vm.prank(owner);
        governor.removeVault(address(vault));
        assertFalse(governor.isRegisteredVault(address(vault)));
    }

    function test_removeVault_notRegistered_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.VaultNotRegistered.selector);
        governor.removeVault(makeAddr("notRegistered"));
    }

    // ==================== GOVERNOR ON VAULT ====================

    function test_governorSetAtInit() public view {
        assertEq(vault.governor(), address(governor));
    }

    function test_executeGovernorBatch_notGovernor_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);

        vm.prank(random);
        vm.expectRevert(ISyndicateVault.NotGovernor.selector);
        vault.executeGovernorBatch(calls);
    }

    // ==================== FUZZ ====================

    function testFuzz_performanceFee(uint256 profit, uint256 feeBps) public {
        feeBps = bound(feeBps, 0, MAX_PERF_FEE_BPS);
        profit = bound(profit, 1e6, 100_000e6); // 1 to 100k USDC

        uint256 proposalId = _createAndExecuteProposal(feeBps, 7 days);

        // Simulate profit
        usdc.mint(address(vault), profit);

        uint256 agentBalBefore = usdc.balanceOf(agent);

        // Agent settles with profit
        vm.prank(agent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        uint256 expectedFee = (profit * feeBps) / 10000;
        assertEq(usdc.balanceOf(agent), agentBalBefore + expectedFee);
    }

    // ==================== TEST GAPS (from PR review) ====================

    function test_vote_buySharesAfterProposal_noVotingPower() public {
        // Create proposal BEFORE random buys shares
        (uint256 proposalId,) = _createSimpleProposal(1500, 7 days);

        // Random buys shares AFTER proposal creation (after snapshot block)
        usdc.mint(random, 50_000e6);
        vm.startPrank(random);
        usdc.approve(address(vault), 50_000e6);
        vault.deposit(50_000e6, random);
        vm.stopPrank();

        vm.warp(block.timestamp + 1);

        // Random has shares now but had zero at snapshot block — cannot vote
        assertGt(vault.balanceOf(random), 0);
        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NoVotingPower.selector);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        // Original LPs can still vote normally
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        uint256 lp1Weight = governor.getVoteWeight(proposalId, lp1);
        assertEq(lp1Weight, 60_000e6);
    }

    function test_settlement_feesNeverExceedProfit() public {
        // Use max performance fee (30%) + management fee (0.5% of remainder)
        uint256 proposalId = _createAndExecuteProposal(MAX_PERF_FEE_BPS, 7 days);

        // Small profit: 1 USDC (1e6) — test boundary
        usdc.mint(address(vault), 1e6);

        uint256 vaultBalBefore = usdc.balanceOf(address(vault));
        uint256 agentBalBefore = usdc.balanceOf(agent);
        uint256 ownerBalBefore = usdc.balanceOf(owner);

        vm.prank(agent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        uint256 agentGot = usdc.balanceOf(agent) - agentBalBefore;
        uint256 ownerGot = usdc.balanceOf(owner) - ownerBalBefore;
        uint256 totalFees = agentGot + ownerGot;

        // Fees must not exceed profit
        assertLe(totalFees, 1e6);

        // Vault should have lost exactly totalFees from the profit
        assertEq(usdc.balanceOf(address(vault)), vaultBalBefore - totalFees);

        // Agent fee: 30% of 1e6 = 300000
        assertEq(agentGot, 300000);
        // Management fee: 0.5% of (1e6 - 300000) = 0.5% of 700000 = 3500
        assertEq(ownerGot, 3500);
    }

    function test_removeVault_withActiveProposal() public {
        // Execute a proposal so it's active
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);
        assertEq(governor.getActiveProposal(address(vault)), proposalId);

        // Governor owner removes the vault while strategy is live
        vm.prank(owner);
        governor.removeVault(address(vault));

        assertFalse(governor.isRegisteredVault(address(vault)));

        // The active proposal is still tracked — settlement still works
        // Agent can still settle (proposal references vault directly, not registry)
        vm.prank(agent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        assertEq(uint256(governor.getProposal(proposalId).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertFalse(vault.redemptionsLocked());

        // But new proposals on this vault are blocked
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});
        calls[1] = BatchExecutorLib.Call({target: address(usdc), data: "", value: 0});

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.VaultNotRegistered.selector);
        governor.propose(address(vault), "ipfs://new", 1500, 7 days, calls, 1, _emptyCoProposers());
    }

    function test_multipleVaults_interleavedProposals() public {
        // Deploy a second vault with its own LPs
        address lp3 = makeAddr("lp3");
        address lp4 = makeAddr("lp4");
        address agent2 = makeAddr("agent2");
        uint256 agent2NftId = agentRegistry.mint(agent2);

        SyndicateVault vaultImpl2 = new SyndicateVault();
        bytes memory vault2Init = abi.encodeCall(
            SyndicateVault.initialize,
            (ISyndicateVault.InitParams({
                    asset: address(usdc),
                    name: "Vault B",
                    symbol: "swUSDC-B",
                    owner: owner,
                    executorImpl: address(executorLib),
                    openDeposits: true,
                    agentRegistry: address(agentRegistry),
                    governor: address(governor),
                    managementFeeBps: 50
                }))
        );
        SyndicateVault vault2 = SyndicateVault(payable(address(new ERC1967Proxy(address(vaultImpl2), vault2Init))));

        vm.startPrank(owner);
        governor.addVault(address(vault2));
        vault2.registerAgent(agent2NftId, agent2);
        vm.stopPrank();

        // Fund and deposit into vault2
        usdc.mint(lp3, 80_000e6);
        usdc.mint(lp4, 20_000e6);

        vm.startPrank(lp3);
        usdc.approve(address(vault2), 80_000e6);
        vault2.deposit(80_000e6, lp3);
        vm.stopPrank();

        vm.startPrank(lp4);
        usdc.approve(address(vault2), 20_000e6);
        vault2.deposit(20_000e6, lp4);
        vm.stopPrank();

        vm.warp(block.timestamp + 1);

        // Create proposals on BOTH vaults
        BatchExecutorLib.Call[] memory calls1 = new BatchExecutorLib.Call[](2);
        calls1[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
        calls1[1] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });

        BatchExecutorLib.Call[] memory calls2 = new BatchExecutorLib.Call[](2);
        calls2[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 30_000e6)), value: 0
        });
        calls2[1] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });

        // Propose on vault1
        vm.prank(agent);
        uint256 pid1 =
            governor.propose(address(vault), "ipfs://v1-strategy", 1500, 7 days, calls1, 1, _emptyCoProposers());

        // Propose on vault2
        vm.prank(agent2);
        uint256 pid2 =
            governor.propose(address(vault2), "ipfs://v2-strategy", 2000, 5 days, calls2, 1, _emptyCoProposers());

        vm.warp(block.timestamp + 1);

        // Vault1 LPs vote on pid1 only
        vm.prank(lp1);
        governor.vote(pid1, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(pid1, ISyndicateGovernor.VoteType.For);

        // Vault2 LPs vote on pid2 only
        vm.prank(lp3);
        governor.vote(pid2, ISyndicateGovernor.VoteType.For);
        vm.prank(lp4);
        governor.vote(pid2, ISyndicateGovernor.VoteType.For);

        // Vault1 LP cannot vote on vault2 proposal (no shares at snapshot)
        vm.prank(lp1);
        vm.expectRevert(ISyndicateGovernor.NoVotingPower.selector);
        governor.vote(pid2, ISyndicateGovernor.VoteType.For);

        // Warp past voting
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        // Execute BOTH — different vaults, both can be live simultaneously
        governor.executeProposal(pid1);
        governor.executeProposal(pid2);

        assertEq(governor.getActiveProposal(address(vault)), pid1);
        assertEq(governor.getActiveProposal(address(vault2)), pid2);
        assertTrue(vault.redemptionsLocked());
        assertTrue(vault2.redemptionsLocked());

        // Settle vault2 first (agent2 settles early)
        vm.prank(agent2);
        governor.settleByAgent(pid2, calls2);

        assertEq(uint256(governor.getProposal(pid2).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertFalse(vault2.redemptionsLocked());
        // Vault1 still locked
        assertTrue(vault.redemptionsLocked());

        // Settle vault1
        vm.prank(agent);
        governor.settleByAgent(pid1, _simpleSettleCalls());

        assertEq(uint256(governor.getProposal(pid1).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertFalse(vault.redemptionsLocked());

        // Both vaults fully settled, independent of each other
        assertEq(governor.getActiveProposal(address(vault)), 0);
        assertEq(governor.getActiveProposal(address(vault2)), 0);
    }
}
