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

contract SyndicateGovernorTest is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    MockAgentRegistry public agentRegistry;

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
    uint256 constant PARAM_CHANGE_DELAY = 1 days;

    ERC20Mock public targetToken;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        targetToken = new ERC20Mock("Target", "TGT", 18);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();
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
                    managementFeeBps: 50
                }))
        );
        vault = SyndicateVault(payable(address(new ERC1967Proxy(address(vaultImpl), vaultInit))));

        vm.prank(owner);
        vault.registerAgent(agentNftId, agent);

        SyndicateGovernor govImpl = new SyndicateGovernor();
        bytes memory govInit = abi.encodeCall(
            SyndicateGovernor.initialize,
            (ISyndicateGovernor.InitParams({
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
                    parameterChangeDelay: PARAM_CHANGE_DELAY,
                    protocolFeeBps: 200,
                    protocolFeeRecipient: owner
                }))
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

        vm.warp(block.timestamp + 1);
    }

    // ==================== HELPERS ====================

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }

    function _simpleExecuteCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
        return calls;
    }

    function _simpleSettlementCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });
        return calls;
    }

    function _createSimpleProposal(uint256 perfFeeBps, uint256 duration) internal returns (uint256 proposalId) {
        vm.prank(agent);
        proposalId = governor.propose(
            address(vault),
            "ipfs://test",
            perfFeeBps,
            duration,
            _simpleExecuteCalls(),
            _simpleSettlementCalls(),
            _emptyCoProposers()
        );
        vm.warp(block.timestamp + 1);
    }

    function _createApprovedProposal(uint256 perfFeeBps, uint256 duration) internal returns (uint256 proposalId) {
        proposalId = _createSimpleProposal(perfFeeBps, duration);
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
    }

    function _createAndExecuteProposal(uint256 perfFeeBps, uint256 duration) internal returns (uint256 proposalId) {
        proposalId = _createApprovedProposal(perfFeeBps, duration);
        governor.executeProposal(proposalId);
    }

    // ==================== INITIALIZATION ====================

    function test_initialize() public view {
        ISyndicateGovernor.GovernorParams memory params = governor.getGovernorParams();
        assertEq(params.votingPeriod, VOTING_PERIOD);
        assertEq(params.executionWindow, EXECUTION_WINDOW);
        assertEq(params.vetoThresholdBps, VETO_THRESHOLD_BPS);
        assertEq(params.maxPerformanceFeeBps, MAX_PERF_FEE_BPS);
        assertEq(params.maxStrategyDuration, MAX_STRATEGY_DURATION);
        assertEq(params.cooldownPeriod, COOLDOWN_PERIOD);
        assertEq(governor.proposalCount(), 0);
        assertTrue(governor.isRegisteredVault(address(vault)));
        assertEq(governor.protocolFeeBps(), 200);
        assertEq(governor.protocolFeeRecipient(), owner);
    }

    // ==================== PROPOSE ====================

    function test_propose() public {
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
        assertEq(proposalId, 1);
        assertEq(governor.proposalCount(), 1);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(p.proposer, agent);
        assertEq(p.vault, address(vault));
        assertEq(p.performanceFeeBps, 1500);
        assertEq(p.strategyDuration, 7 days);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Pending));

        BatchExecutorLib.Call[] memory execCalls = governor.getExecuteCalls(proposalId);
        assertEq(execCalls.length, 1);
        BatchExecutorLib.Call[] memory settleCalls = governor.getSettlementCalls(proposalId);
        assertEq(settleCalls.length, 1);
        BatchExecutorLib.Call[] memory allCalls = governor.getProposalCalls(proposalId);
        assertEq(allCalls.length, 2);
    }

    function test_propose_notRegisteredAgent_reverts() public {
        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotRegisteredAgent.selector);
        governor.propose(
            address(vault),
            "ipfs://test",
            1500,
            7 days,
            _simpleExecuteCalls(),
            _simpleSettlementCalls(),
            _emptyCoProposers()
        );
    }

    function test_propose_vaultNotRegistered_reverts() public {
        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.VaultNotRegistered.selector);
        governor.propose(
            makeAddr("fakeVault"),
            "ipfs://test",
            1500,
            7 days,
            _simpleExecuteCalls(),
            _simpleSettlementCalls(),
            _emptyCoProposers()
        );
    }

    function test_propose_performanceFeeTooHigh_reverts() public {
        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.PerformanceFeeTooHigh.selector);
        governor.propose(
            address(vault),
            "ipfs://test",
            MAX_PERF_FEE_BPS + 1,
            7 days,
            _simpleExecuteCalls(),
            _simpleSettlementCalls(),
            _emptyCoProposers()
        );
    }

    function test_propose_strategyDurationTooLong_reverts() public {
        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.StrategyDurationTooLong.selector);
        governor.propose(
            address(vault),
            "ipfs://test",
            1500,
            MAX_STRATEGY_DURATION + 1,
            _simpleExecuteCalls(),
            _simpleSettlementCalls(),
            _emptyCoProposers()
        );
    }

    function test_propose_strategyDurationTooShort_reverts() public {
        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.StrategyDurationTooShort.selector);
        governor.propose(
            address(vault),
            "ipfs://test",
            1500,
            30 minutes,
            _simpleExecuteCalls(),
            _simpleSettlementCalls(),
            _emptyCoProposers()
        );
    }

    function test_propose_emptyExecuteCalls_reverts() public {
        BatchExecutorLib.Call[] memory empty = new BatchExecutorLib.Call[](0);
        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.EmptyExecuteCalls.selector);
        governor.propose(
            address(vault), "ipfs://test", 1500, 7 days, empty, _simpleSettlementCalls(), _emptyCoProposers()
        );
    }

    function test_propose_emptySettlementCalls_reverts() public {
        BatchExecutorLib.Call[] memory empty = new BatchExecutorLib.Call[](0);
        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.EmptySettlementCalls.selector);
        governor.propose(address(vault), "ipfs://test", 1500, 7 days, _simpleExecuteCalls(), empty, _emptyCoProposers());
    }

    // ==================== VOTING ====================

    function test_vote() public {
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
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
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp1);
        vm.expectRevert(ISyndicateGovernor.AlreadyVoted.selector);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
    }

    function test_vote_noShares_reverts() public {
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NoVotingPower.selector);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
    }

    function test_vote_afterVotingPeriod_reverts() public {
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        vm.prank(lp1);
        vm.expectRevert(ISyndicateGovernor.NotWithinVotingPeriod.selector);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
    }

    // ==================== PROPOSAL STATE RESOLUTION ====================

    function test_proposalState_approved() public {
        uint256 proposalId = _createApprovedProposal(1500, 7 days);
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Approved));
    }

    function test_proposal_passesWithNoVotes() public {
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Approved));
    }

    function test_proposal_rejectedWhenVetoThresholdReached() public {
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Against);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Against);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Rejected));
    }

    function test_proposalState_expired() public {
        uint256 proposalId = _createApprovedProposal(1500, 7 days);
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
        assertEq(governor.getCapitalSnapshot(proposalId), 100_000e6);
    }

    function test_executeProposal_notApproved_reverts() public {
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Against);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Against);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        vm.expectRevert(ISyndicateGovernor.ProposalNotApproved.selector);
        governor.executeProposal(proposalId);
    }

    function test_executeProposal_strategyAlreadyActive_reverts() public {
        _createAndExecuteProposal(1500, 7 days);
        uint256 proposalId2 = _createApprovedProposal(1500, 7 days);
        vm.expectRevert(ISyndicateGovernor.StrategyAlreadyActive.selector);
        governor.executeProposal(proposalId2);
    }

    function test_executeProposal_afterCooldown_succeeds() public {
        uint256 proposalId1 = _createAndExecuteProposal(1500, 7 days);
        vm.prank(agent);
        governor.settleProposal(proposalId1);
        vm.warp(block.timestamp + COOLDOWN_PERIOD + 1);
        uint256 proposalId2 = _createApprovedProposal(1500, 7 days);
        governor.executeProposal(proposalId2);
        assertEq(governor.getActiveProposal(address(vault)), proposalId2);
    }

    // ==================== SETTLEMENT ====================

    function test_settleProposal_proposerSettlesEarly() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);
        vm.prank(agent);
        governor.settleProposal(proposalId);
        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertEq(governor.getActiveProposal(address(vault)), 0);
        assertFalse(vault.redemptionsLocked());
    }

    function test_settleProposal_nonProposerBeforeDuration_reverts() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);
        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.StrategyDurationNotElapsed.selector);
        governor.settleProposal(proposalId);
    }

    function test_settleProposal_permissionless_afterDuration() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);
        vm.warp(block.timestamp + 7 days);
        vm.prank(random);
        governor.settleProposal(proposalId);
        assertEq(uint256(governor.getProposal(proposalId).state), uint256(ISyndicateGovernor.ProposalState.Settled));
    }

    function test_settleProposal_notExecuted_reverts() public {
        uint256 proposalId = _createApprovedProposal(1500, 7 days);
        vm.expectRevert(ISyndicateGovernor.ProposalNotExecuted.selector);
        governor.settleProposal(proposalId);
    }

    function test_emergencySettle_afterDuration() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);
        vm.warp(block.timestamp + 7 days);
        vm.prank(owner);
        governor.emergencySettle(proposalId, _simpleSettlementCalls());
        assertEq(uint256(governor.getProposal(proposalId).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertFalse(vault.redemptionsLocked());
    }

    function test_emergencySettle_beforeDuration_reverts() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.StrategyDurationNotElapsed.selector);
        governor.emergencySettle(proposalId, _simpleSettlementCalls());
    }

    // ==================== P&L CALCULATION ====================

    function test_settlement_noProfit_noFee() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);
        uint256 agentBalBefore = usdc.balanceOf(agent);
        vm.prank(agent);
        governor.settleProposal(proposalId);
        assertEq(usdc.balanceOf(agent), agentBalBefore);
    }

    function test_settlement_withProfit_agentAndManagementFee() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);
        usdc.mint(address(vault), 10_000e6);
        uint256 agentBalBefore = usdc.balanceOf(agent);
        uint256 ownerBalBefore = usdc.balanceOf(owner);
        vm.prank(agent);
        governor.settleProposal(proposalId);
        // Protocol fee: 2% of 10k = 200. Agent fee: 15% of 9800 = 1470. Mgmt: 0.5% of 8330 = 41.65
        assertEq(usdc.balanceOf(agent), agentBalBefore + 1_470e6);
        assertEq(usdc.balanceOf(owner), ownerBalBefore + 200e6 + 41_650000);
    }

    function test_settlement_withLoss_noFees() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);
        usdc.burn(address(vault), 5_000e6);
        uint256 agentBalBefore = usdc.balanceOf(agent);
        vm.prank(agent);
        governor.settleProposal(proposalId);
        assertEq(usdc.balanceOf(agent), agentBalBefore);
    }

    // ==================== REDEMPTION LOCK ====================

    function test_redemptionLock_withdrawReverts() public {
        _createAndExecuteProposal(1500, 7 days);
        vm.prank(lp1);
        vm.expectRevert(ISyndicateVault.RedemptionsLocked.selector);
        vault.withdraw(1_000e6, lp1, lp1);
    }

    function test_redemptionUnlocked_afterSettlement() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);
        vm.prank(agent);
        governor.settleProposal(proposalId);
        vm.prank(lp1);
        uint256 assets = vault.withdraw(1_000e6, lp1, lp1);
        assertEq(assets, 1_000e6);
    }

    // ==================== CANCEL ====================

    function test_cancelProposal() public {
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
        vm.prank(agent);
        governor.cancelProposal(proposalId);
        assertEq(uint256(governor.getProposal(proposalId).state), uint256(ISyndicateGovernor.ProposalState.Cancelled));
    }

    function test_cancelProposal_notProposer_reverts() public {
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotProposer.selector);
        governor.cancelProposal(proposalId);
    }

    function test_emergencyCancel() public {
        uint256 proposalId = _createApprovedProposal(1500, 7 days);
        vm.prank(owner);
        governor.emergencyCancel(proposalId);
        assertEq(uint256(governor.getProposal(proposalId).state), uint256(ISyndicateGovernor.ProposalState.Cancelled));
    }

    function test_emergencyCancel_executedProposal_reverts() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.ProposalNotCancellable.selector);
        governor.emergencyCancel(proposalId);
    }

    // ==================== VETO ====================

    function test_vetoProposal_pending() public {
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
        vm.prank(owner);
        governor.vetoProposal(proposalId);
        assertEq(uint256(governor.getProposal(proposalId).state), uint256(ISyndicateGovernor.ProposalState.Rejected));
    }

    function test_vetoProposal_approved() public {
        uint256 proposalId = _createApprovedProposal(1500, 7 days);
        vm.prank(owner);
        governor.vetoProposal(proposalId);
        assertEq(uint256(governor.getProposal(proposalId).state), uint256(ISyndicateGovernor.ProposalState.Rejected));
    }

    function test_vetoProposal_notVaultOwner_reverts() public {
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotVaultOwner.selector);
        governor.vetoProposal(proposalId);
    }

    function test_vetoProposal_emitsEvent() public {
        uint256 proposalId = _createSimpleProposal(1500, 7 days);
        vm.expectEmit(true, true, false, false);
        emit ISyndicateGovernor.ProposalVetoed(proposalId, owner);
        vm.prank(owner);
        governor.vetoProposal(proposalId);
    }

    function test_emergencySettle_notVaultOwner_reverts() public {
        uint256 proposalId = _createAndExecuteProposal(1500, 7 days);
        vm.warp(block.timestamp + 7 days);
        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotVaultOwner.selector);
        governor.emergencySettle(proposalId, _simpleSettlementCalls());
    }

    // ==================== PARAMETER SETTERS (TIMELOCK) ====================

    function test_setVotingPeriod_queuesChange() public {
        vm.prank(owner);
        governor.setVotingPeriod(2 days);
        assertEq(governor.getGovernorParams().votingPeriod, VOTING_PERIOD);
        vm.warp(block.timestamp + PARAM_CHANGE_DELAY + 1);
        bytes32 key = governor.PARAM_VOTING_PERIOD();
        vm.prank(owner);
        governor.finalizeParameterChange(key);
        assertEq(governor.getGovernorParams().votingPeriod, 2 days);
    }

    function test_setVotingPeriod_tooLow_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.InvalidVotingPeriod.selector);
        governor.setVotingPeriod(30 minutes);
    }

    function test_setters_notOwner_reverts() public {
        vm.startPrank(random);
        vm.expectRevert();
        governor.setVotingPeriod(2 days);
        vm.expectRevert();
        governor.setExecutionWindow(2 days);
        vm.expectRevert();
        governor.setVetoThresholdBps(5000);
        vm.expectRevert();
        governor.setMaxPerformanceFeeBps(2000);
        vm.expectRevert();
        governor.setMaxStrategyDuration(20 days);
        vm.expectRevert();
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

    function test_removeVault() public {
        vm.prank(owner);
        governor.removeVault(address(vault));
        assertFalse(governor.isRegisteredVault(address(vault)));
    }

    function test_addVault_fromFactory() public {
        address newVault = makeAddr("factoryVault");
        address factoryAddr = makeAddr("factory");
        vm.prank(owner);
        governor.setFactory(factoryAddr);
        vm.prank(factoryAddr);
        governor.addVault(newVault);
        assertTrue(governor.isRegisteredVault(newVault));
    }

    function test_addVault_unauthorizedCaller_reverts() public {
        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotAuthorized.selector);
        governor.addVault(makeAddr("some"));
    }

    // ==================== GOVERNOR ON VAULT ====================

    function test_governor_readFromFactory() public view {
        assertEq(vault.governor(), address(governor));
    }

    function test_redemptionsLocked_duringActiveProposal() public {
        assertFalse(vault.redemptionsLocked());
        _createAndExecuteProposal(1500, 7 days);
        assertTrue(vault.redemptionsLocked());
    }

    function test_executeGovernorBatch_notGovernor_reverts() public {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](0);
        vm.prank(random);
        vm.expectRevert(ISyndicateVault.NotGovernor.selector);
        vault.executeGovernorBatch(calls);
    }
}
