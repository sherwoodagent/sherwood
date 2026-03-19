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

contract CollaborativeProposalsTest is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    MockAgentRegistry public agentRegistry;

    address public owner = makeAddr("owner");
    address public leadAgent = makeAddr("leadAgent");
    address public leadAgentEoa = makeAddr("leadAgentEoa");
    address public coAgent1 = makeAddr("coAgent1");
    address public coAgent1Eoa = makeAddr("coAgent1Eoa");
    address public coAgent2 = makeAddr("coAgent2");
    address public coAgent2Eoa = makeAddr("coAgent2Eoa");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public random = makeAddr("random");

    uint256 public leadNftId;
    uint256 public coNftId1;
    uint256 public coNftId2;

    ERC20Mock public targetToken;

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant QUORUM_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant COOLDOWN_PERIOD = 1 days;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        targetToken = new ERC20Mock("Target", "TGT", 18);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();

        leadNftId = agentRegistry.mint(leadAgentEoa);
        coNftId1 = agentRegistry.mint(coAgent1Eoa);
        coNftId2 = agentRegistry.mint(coAgent2Eoa);

        // Deploy vault
        // Deploy governor first
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

        // Register agents
        vm.startPrank(owner);
        vault.registerAgent(leadNftId, leadAgent, leadAgentEoa);
        vault.registerAgent(coNftId1, coAgent1, coAgent1Eoa);
        vm.stopPrank();
        vm.startPrank(owner);
        vault.registerAgent(coNftId2, coAgent2, coAgent2Eoa);
        governor.addVault(address(vault));
        vm.stopPrank();

        // Fund LPs
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

    function _simpleCalls() internal view returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
        calls[1] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });
    }

    function _simpleSettleCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });
        return calls;
    }

    /// @dev Create a collaborative proposal with lead (60%) + coAgent1 (30%) + coAgent2 (10%)
    function _createCollabProposal() internal returns (uint256 proposalId) {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](2);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 3000});
        coProps[1] = ISyndicateGovernor.CoProposer({agent: coAgent2, splitBps: 1000});

        vm.prank(leadAgent);
        proposalId = governor.propose(address(vault), "ipfs://collab", 2000, 7 days, _simpleCalls(), 1, coProps);
    }

    /// @dev Create collab proposal, get all approvals, advance to Pending
    function _createApprovedCollabProposal() internal returns (uint256 proposalId) {
        proposalId = _createCollabProposal();

        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);
        vm.prank(coAgent2);
        governor.approveCollaboration(proposalId);

        // Now in Pending, mine a block for snapshot
        vm.warp(block.timestamp + 1);
    }

    /// @dev Create collab proposal, approve, vote, advance past voting
    function _createVotedCollabProposal() internal returns (uint256 proposalId) {
        proposalId = _createApprovedCollabProposal();

        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
    }

    /// @dev Full lifecycle up to execution
    function _createAndExecuteCollabProposal() internal returns (uint256 proposalId) {
        proposalId = _createVotedCollabProposal();
        governor.executeProposal(proposalId);
    }

    // ==================== SOLO BACKWARD COMPATIBILITY ====================

    function test_soloProposal_backwardCompatible() public {
        vm.prank(leadAgent);
        uint256 proposalId =
            governor.propose(address(vault), "ipfs://solo", 1500, 7 days, _simpleCalls(), 1, _emptyCoProposers());

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Pending));

        ISyndicateGovernor.CoProposer[] memory coProps = governor.getCoProposers(proposalId);
        assertEq(coProps.length, 0);
    }

    function test_soloProposal_settlementGoesToProposer() public {
        vm.prank(leadAgent);
        uint256 proposalId =
            governor.propose(address(vault), "ipfs://solo", 1500, 7 days, _simpleCalls(), 1, _emptyCoProposers());

        vm.warp(block.timestamp + 1);

        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);

        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        governor.executeProposal(proposalId);

        // Simulate profit
        usdc.mint(address(vault), 10_000e6);

        uint256 leadBalBefore = usdc.balanceOf(leadAgent);

        vm.prank(leadAgent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        // 15% of 10k = 1500
        assertEq(usdc.balanceOf(leadAgent), leadBalBefore + 1_500e6);
    }

    // ==================== COLLABORATIVE PROPOSAL CREATION ====================

    function test_collabProposal_createdInDraftState() public {
        uint256 proposalId = _createCollabProposal();

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Draft));
    }

    function test_collabProposal_storesCoProposers() public {
        uint256 proposalId = _createCollabProposal();

        ISyndicateGovernor.CoProposer[] memory coProps = governor.getCoProposers(proposalId);
        assertEq(coProps.length, 2);
        assertEq(coProps[0].agent, coAgent1);
        assertEq(coProps[0].splitBps, 3000);
        assertEq(coProps[1].agent, coAgent2);
        assertEq(coProps[1].splitBps, 1000);
    }

    function test_collabProposal_emitsEvents() public {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](1);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 3000});

        address[] memory expectedAddrs = new address[](1);
        expectedAddrs[0] = coAgent1;
        uint256[] memory expectedSplits = new uint256[](1);
        expectedSplits[0] = 3000;

        vm.prank(leadAgent);
        vm.expectEmit(true, true, false, true);
        emit ISyndicateGovernor.CollaborativeProposalCreated(1, leadAgent, expectedAddrs, expectedSplits);
        governor.propose(address(vault), "ipfs://collab", 2000, 7 days, _simpleCalls(), 1, coProps);
    }

    // ==================== FULL CONSENT FLOW ====================

    function test_fullConsentFlow_allApprove_transitionsToPending() public {
        uint256 proposalId = _createCollabProposal();

        // First co-proposer approves
        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);

        // Still Draft
        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Draft));

        // Second co-proposer approves → should transition to Pending
        vm.prank(coAgent2);
        governor.approveCollaboration(proposalId);

        p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Pending));
    }

    function test_fullConsentFlow_votingTimestampsResetOnTransition() public {
        uint256 proposalId = _createCollabProposal();

        // Warp forward some time during Draft
        vm.warp(block.timestamp + 12 hours);

        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);
        vm.prank(coAgent2);
        governor.approveCollaboration(proposalId);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        // Snapshot and vote end should be reset to current timestamp
        assertEq(p.snapshotTimestamp, block.timestamp);
        assertEq(p.voteEnd, block.timestamp + VOTING_PERIOD);
        assertEq(p.executeBy, block.timestamp + VOTING_PERIOD + EXECUTION_WINDOW);
    }

    function test_fullConsentFlow_completeLifecycle() public {
        uint256 proposalId = _createAndExecuteCollabProposal();

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Executed));
        assertTrue(vault.redemptionsLocked());
    }

    // ==================== REJECTION ====================

    function test_rejection_cancelsProposal() public {
        uint256 proposalId = _createCollabProposal();

        vm.prank(coAgent1);
        governor.rejectCollaboration(proposalId);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Cancelled));
    }

    function test_rejection_afterPartialApproval_cancels() public {
        uint256 proposalId = _createCollabProposal();

        // Agent1 approves
        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);

        // Agent2 rejects
        vm.prank(coAgent2);
        governor.rejectCollaboration(proposalId);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Cancelled));
    }

    // ==================== EXPIRY ====================

    function test_expiry_afterDeadline_autoResolves() public {
        uint256 proposalId = _createCollabProposal();

        // Only one approves
        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);

        // Warp past collaboration window (default 48h)
        vm.warp(block.timestamp + 48 hours + 1);

        // State auto-resolves to Expired via getProposalState
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Expired));
    }

    function test_expiry_beforeDeadline_stillDraft() public {
        uint256 proposalId = _createCollabProposal();

        // Still within deadline
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Draft));
    }

    function test_expiry_blocksApproval() public {
        uint256 proposalId = _createCollabProposal();

        // Warp past deadline
        vm.warp(block.timestamp + 48 hours + 1);

        // Trying to approve after expiry reverts
        vm.prank(coAgent1);
        vm.expectRevert(ISyndicateGovernor.CollaborationExpired.selector);
        governor.approveCollaboration(proposalId);
    }

    // ==================== SETTLEMENT FEE DISTRIBUTION ====================

    function test_settlement_feeDistribution_collaborative() public {
        // Lead 60%, coAgent1 30%, coAgent2 10%
        uint256 proposalId = _createAndExecuteCollabProposal();

        // Simulate profit: 10k USDC
        usdc.mint(address(vault), 10_000e6);

        uint256 leadBalBefore = usdc.balanceOf(leadAgent);
        uint256 co1BalBefore = usdc.balanceOf(coAgent1);
        uint256 co2BalBefore = usdc.balanceOf(coAgent2);

        vm.prank(leadAgent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        // Performance fee: 20% of 10k = 2000 USDC
        // coAgent1: 30% of 2000 = 600
        // coAgent2: 10% of 2000 = 200
        // Lead: remainder = 2000 - 600 - 200 = 1200
        assertEq(usdc.balanceOf(coAgent1), co1BalBefore + 600e6);
        assertEq(usdc.balanceOf(coAgent2), co2BalBefore + 200e6);
        assertEq(usdc.balanceOf(leadAgent), leadBalBefore + 1_200e6);
    }

    function test_settlement_feeDistribution_managementFeeUnchanged() public {
        uint256 proposalId = _createAndExecuteCollabProposal();

        usdc.mint(address(vault), 10_000e6);

        uint256 ownerBalBefore = usdc.balanceOf(owner);

        vm.prank(leadAgent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        // Agent fee: 20% of 10k = 2000
        // Management fee: 0.5% of (10k - 2000) = 0.5% of 8000 = 40
        assertEq(usdc.balanceOf(owner), ownerBalBefore + 40e6);
    }

    function test_settlement_noProfit_noDistribution() public {
        uint256 proposalId = _createAndExecuteCollabProposal();

        uint256 leadBalBefore = usdc.balanceOf(leadAgent);
        uint256 co1BalBefore = usdc.balanceOf(coAgent1);

        vm.prank(leadAgent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        assertEq(usdc.balanceOf(leadAgent), leadBalBefore);
        assertEq(usdc.balanceOf(coAgent1), co1BalBefore);
    }

    // ==================== ROUNDING ====================

    function test_settlement_rounding_leadGetsRemainder() public {
        // Use splits that cause rounding: lead 60%, coAgent1 33%, coAgent2 7%
        // Actually let's use 3333 + 3334 = 6667 → lead = 3333
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](2);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 3333});
        coProps[1] = ISyndicateGovernor.CoProposer({agent: coAgent2, splitBps: 3334});

        vm.prank(leadAgent);
        uint256 proposalId = governor.propose(address(vault), "ipfs://round", 2000, 7 days, _simpleCalls(), 1, coProps);

        // Approve
        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);
        vm.prank(coAgent2);
        governor.approveCollaboration(proposalId);
        vm.warp(block.timestamp + 1);

        // Vote
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        // Execute
        governor.executeProposal(proposalId);

        // Simulate profit that doesn't divide evenly: 7 USDC
        usdc.mint(address(vault), 7e6);

        uint256 leadBalBefore = usdc.balanceOf(leadAgent);
        uint256 co1BalBefore = usdc.balanceOf(coAgent1);
        uint256 co2BalBefore = usdc.balanceOf(coAgent2);

        vm.prank(leadAgent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        // Performance fee: 20% of 7e6 = 1_400_000
        uint256 agentFee = 1_400_000;
        // coAgent1: 3333/10000 * 1400000 = 466620
        // coAgent2: 3334/10000 * 1400000 = 466760
        // Total distributed: 466620 + 466760 = 933380
        // Lead remainder: 1400000 - 933380 = 466620
        uint256 co1Share = (agentFee * 3333) / 10000; // 466620
        uint256 co2Share = (agentFee * 3334) / 10000; // 466760
        uint256 leadShare = agentFee - co1Share - co2Share; // 466620

        assertEq(usdc.balanceOf(coAgent1), co1BalBefore + co1Share);
        assertEq(usdc.balanceOf(coAgent2), co2BalBefore + co2Share);
        assertEq(usdc.balanceOf(leadAgent), leadBalBefore + leadShare);

        // Total distributed equals agent fee exactly
        assertEq(co1Share + co2Share + leadShare, agentFee);
    }

    // ==================== VALIDATION ====================

    function test_validation_invalidSplits_totalExceeds10000() public {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](2);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 5000});
        coProps[1] = ISyndicateGovernor.CoProposer({agent: coAgent2, splitBps: 5000});
        // Total co = 10000, lead = 0 → LeadSplitTooLow

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.InvalidSplits.selector);
        governor.propose(address(vault), "ipfs://test", 2000, 7 days, _simpleCalls(), 1, coProps);
    }

    function test_validation_splitTooLow() public {
        // One co-proposer has less than 100 bps (1%)
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](1);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 50}); // 0.5%

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.SplitTooLow.selector);
        governor.propose(address(vault), "ipfs://test", 2000, 7 days, _simpleCalls(), 1, coProps);
    }

    function test_validation_tooManyCoProposers() public {
        // Register extra agents
        address co3 = makeAddr("co3");
        address co4 = makeAddr("co4");
        address co5 = makeAddr("co5");
        address co6 = makeAddr("co6");
        vm.startPrank(owner);
        vault.registerAgent(agentRegistry.mint(makeAddr("co3Eoa")), co3, makeAddr("co3Eoa"));
        vault.registerAgent(agentRegistry.mint(makeAddr("co4Eoa")), co4, makeAddr("co4Eoa"));
        vault.registerAgent(agentRegistry.mint(makeAddr("co5Eoa")), co5, makeAddr("co5Eoa"));
        vault.registerAgent(agentRegistry.mint(makeAddr("co6Eoa")), co6, makeAddr("co6Eoa"));
        vm.stopPrank();

        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](6);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 1000});
        coProps[1] = ISyndicateGovernor.CoProposer({agent: coAgent2, splitBps: 1000});
        coProps[2] = ISyndicateGovernor.CoProposer({agent: co3, splitBps: 1000});
        coProps[3] = ISyndicateGovernor.CoProposer({agent: co4, splitBps: 1000});
        coProps[4] = ISyndicateGovernor.CoProposer({agent: co5, splitBps: 1000});
        coProps[5] = ISyndicateGovernor.CoProposer({agent: co6, splitBps: 1000});

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.TooManyCoProposers.selector);
        governor.propose(address(vault), "ipfs://test", 2000, 7 days, _simpleCalls(), 1, coProps);
    }

    function test_validation_unregisteredAgent() public {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](1);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: random, splitBps: 3000}); // not registered

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.NotRegisteredAgent.selector);
        governor.propose(address(vault), "ipfs://test", 2000, 7 days, _simpleCalls(), 1, coProps);
    }

    function test_validation_duplicateCoProposer() public {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](2);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 3000});
        coProps[1] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 2000}); // duplicate

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.DuplicateCoProposer.selector);
        governor.propose(address(vault), "ipfs://test", 2000, 7 days, _simpleCalls(), 1, coProps);
    }

    function test_validation_leadCannotBeCoProposer() public {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](1);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: leadAgent, splitBps: 3000}); // lead is co-proposer

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.DuplicateCoProposer.selector);
        governor.propose(address(vault), "ipfs://test", 2000, 7 days, _simpleCalls(), 1, coProps);
    }

    function test_validation_maxCoProposers_succeeds() public {
        // Register 3 more agents (already have 2 co-agents)
        address co3 = makeAddr("co3");
        address co4 = makeAddr("co4");
        address co5 = makeAddr("co5");
        vm.startPrank(owner);
        vault.registerAgent(agentRegistry.mint(makeAddr("co3Eoa")), co3, makeAddr("co3Eoa"));
        vault.registerAgent(agentRegistry.mint(makeAddr("co4Eoa")), co4, makeAddr("co4Eoa"));
        vault.registerAgent(agentRegistry.mint(makeAddr("co5Eoa")), co5, makeAddr("co5Eoa"));
        vm.stopPrank();

        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](5);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 1500});
        coProps[1] = ISyndicateGovernor.CoProposer({agent: coAgent2, splitBps: 1500});
        coProps[2] = ISyndicateGovernor.CoProposer({agent: co3, splitBps: 1500});
        coProps[3] = ISyndicateGovernor.CoProposer({agent: co4, splitBps: 1500});
        coProps[4] = ISyndicateGovernor.CoProposer({agent: co5, splitBps: 1500});
        // Total co = 7500, lead = 2500 (above 1000 min)

        vm.prank(leadAgent);
        uint256 proposalId = governor.propose(address(vault), "ipfs://max", 2000, 7 days, _simpleCalls(), 1, coProps);

        ISyndicateGovernor.CoProposer[] memory stored = governor.getCoProposers(proposalId);
        assertEq(stored.length, 5);
    }

    // ==================== ACCESS CONTROL ====================

    function test_approveCollaboration_nonCoProposer_reverts() public {
        uint256 proposalId = _createCollabProposal();

        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotCoProposer.selector);
        governor.approveCollaboration(proposalId);
    }

    function test_approveCollaboration_leadProposer_reverts() public {
        uint256 proposalId = _createCollabProposal();

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.NotCoProposer.selector);
        governor.approveCollaboration(proposalId);
    }

    function test_approveCollaboration_alreadyApproved_reverts() public {
        uint256 proposalId = _createCollabProposal();

        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);

        vm.prank(coAgent1);
        vm.expectRevert(ISyndicateGovernor.AlreadyApproved.selector);
        governor.approveCollaboration(proposalId);
    }

    function test_approveCollaboration_afterExpiry_reverts() public {
        uint256 proposalId = _createCollabProposal();

        vm.warp(block.timestamp + 48 hours + 1);

        vm.prank(coAgent1);
        vm.expectRevert(ISyndicateGovernor.CollaborationExpired.selector);
        governor.approveCollaboration(proposalId);
    }

    function test_approveCollaboration_notDraftState_reverts() public {
        uint256 proposalId = _createApprovedCollabProposal();

        // Now in Pending, coAgent1 already approved — but let's test with a freshly created scenario
        // This should fail because state is Pending, not Draft
        vm.prank(coAgent1);
        vm.expectRevert(ISyndicateGovernor.NotDraftState.selector);
        governor.approveCollaboration(proposalId);
    }

    function test_rejectCollaboration_nonCoProposer_reverts() public {
        uint256 proposalId = _createCollabProposal();

        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotCoProposer.selector);
        governor.rejectCollaboration(proposalId);
    }

    function test_rejectCollaboration_notDraftState_reverts() public {
        uint256 proposalId = _createApprovedCollabProposal();

        vm.prank(coAgent1);
        vm.expectRevert(ISyndicateGovernor.NotDraftState.selector);
        governor.rejectCollaboration(proposalId);
    }

    // ==================== CANCEL DURING DRAFT ====================

    function test_cancelDraftProposal_byLeadProposer() public {
        uint256 proposalId = _createCollabProposal();

        vm.prank(leadAgent);
        governor.cancelProposal(proposalId);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Cancelled));
    }

    function test_emergencyCancel_draftProposal() public {
        uint256 proposalId = _createCollabProposal();

        vm.prank(owner);
        governor.emergencyCancel(proposalId);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Cancelled));
    }

    // ==================== VOTE BLOCKED DURING DRAFT ====================

    function test_vote_duringDraft_reverts() public {
        uint256 proposalId = _createCollabProposal();

        vm.prank(lp1);
        vm.expectRevert(ISyndicateGovernor.NotWithinVotingPeriod.selector);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
    }

    // ==================== COLLABORATION WINDOW SETTER ====================

    function test_setCollaborationWindow() public {
        vm.prank(owner);
        governor.setCollaborationWindow(24 hours);

        // Create a new collab proposal — its deadline should use the new window
        uint256 tsBefore = block.timestamp;
        uint256 proposalId = _createCollabProposal();

        // Warp past 24h but before 48h — auto-resolves to Expired
        vm.warp(tsBefore + 24 hours + 1);

        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Expired));
    }

    function test_setCollaborationWindow_notOwner_reverts() public {
        vm.prank(random);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, random));
        governor.setCollaborationWindow(24 hours);
    }

    // ==================== PERMISSIONLESS SETTLEMENT WITH CO-PROPOSERS ====================

    function test_permissionlessSettle_distributesToCoProposers() public {
        uint256 proposalId = _createAndExecuteCollabProposal();

        // Simulate profit
        usdc.mint(address(vault), 10_000e6);

        uint256 leadBalBefore = usdc.balanceOf(leadAgent);
        uint256 co1BalBefore = usdc.balanceOf(coAgent1);
        uint256 co2BalBefore = usdc.balanceOf(coAgent2);

        // Warp past strategy duration for permissionless settle
        vm.warp(block.timestamp + 7 days);

        vm.prank(random);
        governor.settleProposal(proposalId);

        // Same distribution as agent settle
        assertEq(usdc.balanceOf(coAgent1), co1BalBefore + 600e6);
        assertEq(usdc.balanceOf(coAgent2), co2BalBefore + 200e6);
        assertEq(usdc.balanceOf(leadAgent), leadBalBefore + 1_200e6);
    }

    // ==================== SINGLE CO-PROPOSER ====================

    // ==================== SETTER BOUNDARY TESTS ====================

    function test_setCollaborationWindow_belowMin_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.InvalidCollaborationWindow.selector);
        governor.setCollaborationWindow(30 minutes);
    }

    function test_setCollaborationWindow_aboveMax_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.InvalidCollaborationWindow.selector);
        governor.setCollaborationWindow(8 days);
    }

    function test_setMaxCoProposers_zero_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.InvalidMaxCoProposers.selector);
        governor.setMaxCoProposers(0);
    }

    function test_setMaxCoProposers_aboveAbsoluteMax_reverts() public {
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.InvalidMaxCoProposers.selector);
        governor.setMaxCoProposers(11);
    }

    function test_setMaxCoProposers_succeeds() public {
        vm.prank(owner);
        governor.setMaxCoProposers(3);
        assertEq(governor.getGovernorParams().maxCoProposers, 3);
    }

    function test_setMaxCoProposers_notOwner_reverts() public {
        vm.prank(random);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, random));
        governor.setMaxCoProposers(3);
    }

    // ==================== ADDITIONAL ACCESS CONTROL ====================

    function test_rejectCollaboration_leadProposer_reverts() public {
        uint256 proposalId = _createCollabProposal();

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.NotCoProposer.selector);
        governor.rejectCollaboration(proposalId);
    }

    function test_settleByAgent_coProposer_reverts() public {
        uint256 proposalId = _createAndExecuteCollabProposal();

        vm.prank(coAgent1);
        vm.expectRevert(ISyndicateGovernor.NotProposer.selector);
        governor.settleByAgent(proposalId, _simpleSettleCalls());
    }

    // ==================== SINGLE CO-PROPOSER ====================

    function test_singleCoProposer_fullLifecycle() public {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](1);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 4000}); // lead = 60%

        vm.prank(leadAgent);
        uint256 proposalId = governor.propose(address(vault), "ipfs://duo", 2000, 7 days, _simpleCalls(), 1, coProps);

        // Only one approval needed
        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);

        // Should be Pending now
        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Pending));

        vm.warp(block.timestamp + 1);

        // Vote + execute
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        governor.executeProposal(proposalId);

        // Profit + settle
        usdc.mint(address(vault), 5_000e6);

        uint256 leadBalBefore = usdc.balanceOf(leadAgent);
        uint256 co1BalBefore = usdc.balanceOf(coAgent1);

        vm.prank(leadAgent);
        governor.settleByAgent(proposalId, _simpleSettleCalls());

        // Fee: 20% of 5k = 1000
        // coAgent1: 40% of 1000 = 400
        // Lead: 1000 - 400 = 600
        assertEq(usdc.balanceOf(coAgent1), co1BalBefore + 400e6);
        assertEq(usdc.balanceOf(leadAgent), leadBalBefore + 600e6);
    }
}
