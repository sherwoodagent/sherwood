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
import {MockRegistryMinimal} from "./mocks/MockRegistryMinimal.sol";

contract CollaborativeProposalsTest is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    MockAgentRegistry public agentRegistry;
    MockRegistryMinimal public guardianRegistry;

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
    uint256 constant VETO_THRESHOLD_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant COOLDOWN_PERIOD = 1 days;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        targetToken = new ERC20Mock("Target", "TGT", 18);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();
        guardianRegistry = new MockRegistryMinimal();

        leadNftId = agentRegistry.mint(leadAgent);
        coNftId1 = agentRegistry.mint(coAgent1);
        coNftId2 = agentRegistry.mint(coAgent2);

        // Deploy governor first
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
                    minStrategyDuration: 1 days,
                    maxStrategyDuration: 7 days,
                    protocolFeeBps: 0,
                    protocolFeeRecipient: address(0),
                    guardianFeeBps: 0
                }),
                address(guardianRegistry)
            )
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
                    managementFeeBps: 50
                }))
        );
        vault = SyndicateVault(payable(address(new ERC1967Proxy(address(vaultImpl), vaultInit))));

        // Mock factory.governor() on the test contract (which is the deployer / factory stand-in)
        vm.mockCall(address(this), abi.encodeWithSignature("governor()"), abi.encode(address(governor)));

        // Register agents
        vm.startPrank(owner);
        vault.registerAgent(leadNftId, leadAgent);
        vault.registerAgent(coNftId1, coAgent1);
        vault.registerAgent(coNftId2, coAgent2);
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

    /// @dev Create a collaborative proposal with lead (60%) + coAgent1 (30%) + coAgent2 (10%)
    function _createCollabProposal() internal returns (uint256 proposalId) {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](2);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 3000});
        coProps[1] = ISyndicateGovernor.CoProposer({agent: coAgent2, splitBps: 1000});

        vm.prank(leadAgent);
        proposalId = governor.propose(
            address(vault), "ipfs://collab", 2000, 7 days, _simpleExecuteCalls(), _simpleSettlementCalls(), coProps
        );
    }

    /// @dev Create collab proposal, get all approvals, advance to Pending
    function _createApprovedCollabProposal() internal returns (uint256 proposalId) {
        proposalId = _createCollabProposal();
        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);
        vm.prank(coAgent2);
        governor.approveCollaboration(proposalId);
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
        uint256 proposalId = governor.propose(
            address(vault),
            "ipfs://solo",
            1500,
            7 days,
            _simpleExecuteCalls(),
            _simpleSettlementCalls(),
            _emptyCoProposers()
        );

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Pending));

        ISyndicateGovernor.CoProposer[] memory coProps = governor.getCoProposers(proposalId);
        assertEq(coProps.length, 0);
    }

    function test_soloProposal_settlementGoesToProposer() public {
        vm.prank(leadAgent);
        uint256 proposalId = governor.propose(
            address(vault),
            "ipfs://solo",
            1500,
            7 days,
            _simpleExecuteCalls(),
            _simpleSettlementCalls(),
            _emptyCoProposers()
        );
        vm.warp(block.timestamp + 1);

        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);
        governor.executeProposal(proposalId);

        usdc.mint(address(vault), 10_000e6);
        uint256 leadBalBefore = usdc.balanceOf(leadAgent);

        // Proposer settles early
        vm.prank(leadAgent);
        governor.settleProposal(proposalId);

        // 15% of 10k = 1500 (no protocol fee since it's 0)
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

    // ==================== FULL CONSENT FLOW ====================

    function test_fullConsentFlow_allApprove_transitionsToPending() public {
        uint256 proposalId = _createCollabProposal();

        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);
        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Draft));

        vm.prank(coAgent2);
        governor.approveCollaboration(proposalId);
        p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Pending));
    }

    /// @notice G-C1: approveCollaboration() must also stamp the snapshot at
    ///         block.timestamp - 1 when Draft -> Pending transition fires, so
    ///         a same-block delegation cannot be counted. Mirrors propose().
    function test_approveCollaboration_snapshotIsPriorTimestamp() public {
        uint256 proposalId = _createCollabProposal();
        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);
        uint256 tsAtTransition = block.timestamp;
        vm.prank(coAgent2);
        governor.approveCollaboration(proposalId);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Pending));
        assertEq(p.snapshotTimestamp, tsAtTransition - 1);
    }

    function test_fullConsentFlow_votingTimestampsResetOnTransition() public {
        uint256 proposalId = _createCollabProposal();
        vm.warp(block.timestamp + 12 hours);

        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);
        vm.prank(coAgent2);
        governor.approveCollaboration(proposalId);

        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        // G-C1: snapshot stamped one second in the past so same-block
        // delegations cannot count via ERC20Votes.getPastVotes.
        assertEq(p.snapshotTimestamp, block.timestamp - 1);
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
        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);
        vm.prank(coAgent2);
        governor.rejectCollaboration(proposalId);
        ISyndicateGovernor.StrategyProposal memory p = governor.getProposal(proposalId);
        assertEq(uint256(p.state), uint256(ISyndicateGovernor.ProposalState.Cancelled));
    }

    // ==================== EXPIRY ====================

    function test_expiry_afterDeadline_autoResolves() public {
        uint256 proposalId = _createCollabProposal();
        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);
        vm.warp(block.timestamp + 48 hours + 1);
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Expired));
    }

    function test_expiry_beforeDeadline_stillDraft() public {
        uint256 proposalId = _createCollabProposal();
        assertEq(uint256(governor.getProposalState(proposalId)), uint256(ISyndicateGovernor.ProposalState.Draft));
    }

    function test_expiry_blocksApproval() public {
        uint256 proposalId = _createCollabProposal();
        vm.warp(block.timestamp + 48 hours + 1);
        vm.prank(coAgent1);
        vm.expectRevert(ISyndicateGovernor.CollaborationExpired.selector);
        governor.approveCollaboration(proposalId);
    }

    // ==================== SETTLEMENT FEE DISTRIBUTION ====================

    function test_settlement_feeDistribution_collaborative() public {
        // Lead 60%, coAgent1 30%, coAgent2 10%
        uint256 proposalId = _createAndExecuteCollabProposal();
        usdc.mint(address(vault), 10_000e6);

        uint256 leadBalBefore = usdc.balanceOf(leadAgent);
        uint256 co1BalBefore = usdc.balanceOf(coAgent1);
        uint256 co2BalBefore = usdc.balanceOf(coAgent2);

        // Proposer settles early
        vm.prank(leadAgent);
        governor.settleProposal(proposalId);

        // Performance fee: 20% of 10k = 2000 USDC (no protocol fee)
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
        governor.settleProposal(proposalId);

        // Agent fee: 20% of 10k = 2000. Management fee: 0.5% of (10k - 2000) = 40
        assertEq(usdc.balanceOf(owner), ownerBalBefore + 40e6);
    }

    function test_settlement_noProfit_noDistribution() public {
        uint256 proposalId = _createAndExecuteCollabProposal();
        uint256 leadBalBefore = usdc.balanceOf(leadAgent);
        uint256 co1BalBefore = usdc.balanceOf(coAgent1);

        vm.prank(leadAgent);
        governor.settleProposal(proposalId);

        assertEq(usdc.balanceOf(leadAgent), leadBalBefore);
        assertEq(usdc.balanceOf(coAgent1), co1BalBefore);
    }

    // ==================== ROUNDING ====================

    function test_settlement_rounding_leadGetsRemainder() public {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](2);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 3333});
        coProps[1] = ISyndicateGovernor.CoProposer({agent: coAgent2, splitBps: 3334});

        vm.prank(leadAgent);
        uint256 proposalId = governor.propose(
            address(vault), "ipfs://round", 2000, 7 days, _simpleExecuteCalls(), _simpleSettlementCalls(), coProps
        );

        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);
        vm.prank(coAgent2);
        governor.approveCollaboration(proposalId);
        vm.warp(block.timestamp + 1);

        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        governor.executeProposal(proposalId);
        usdc.mint(address(vault), 7e6);

        uint256 leadBalBefore = usdc.balanceOf(leadAgent);
        uint256 co1BalBefore = usdc.balanceOf(coAgent1);
        uint256 co2BalBefore = usdc.balanceOf(coAgent2);

        vm.prank(leadAgent);
        governor.settleProposal(proposalId);

        uint256 agentFee = 1_400_000; // 20% of 7e6
        uint256 co1Share = (agentFee * 3333) / 10000;
        uint256 co2Share = (agentFee * 3334) / 10000;
        uint256 leadShare = agentFee - co1Share - co2Share;

        assertEq(usdc.balanceOf(coAgent1), co1BalBefore + co1Share);
        assertEq(usdc.balanceOf(coAgent2), co2BalBefore + co2Share);
        assertEq(usdc.balanceOf(leadAgent), leadBalBefore + leadShare);
        assertEq(co1Share + co2Share + leadShare, agentFee);
    }

    // ==================== G-C7: zero-rounding regression ====================

    /// @dev 5 active co-proposers each at MIN_SPLIT_BPS (100 bps). If the agent
    ///      fee is small enough that `fee * 100 / 10000` rounds to zero, each
    ///      active co-prop is floored at 1 wei (C-11 fix). Settlement no
    ///      longer reverts on tiny PnL.
    function test_coProposerShare_floorAtOneWei() public {
        // Register 3 additional co-props so we can hit 5 at 100bps each.
        address co3 = makeAddr("co3");
        address co4 = makeAddr("co4");
        address co5 = makeAddr("co5");
        vm.startPrank(owner);
        vault.registerAgent(agentRegistry.mint(co3), co3);
        vault.registerAgent(agentRegistry.mint(co4), co4);
        vault.registerAgent(agentRegistry.mint(co5), co5);
        vm.stopPrank();

        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](5);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 100});
        coProps[1] = ISyndicateGovernor.CoProposer({agent: coAgent2, splitBps: 100});
        coProps[2] = ISyndicateGovernor.CoProposer({agent: co3, splitBps: 100});
        coProps[3] = ISyndicateGovernor.CoProposer({agent: co4, splitBps: 100});
        coProps[4] = ISyndicateGovernor.CoProposer({agent: co5, splitBps: 100});

        vm.prank(leadAgent);
        uint256 proposalId = governor.propose(
            address(vault), "ipfs://tiny", 2000, 7 days, _simpleExecuteCalls(), _simpleSettlementCalls(), coProps
        );
        vm.prank(coAgent1);
        governor.approveCollaboration(proposalId);
        vm.prank(coAgent2);
        governor.approveCollaboration(proposalId);
        vm.prank(co3);
        governor.approveCollaboration(proposalId);
        vm.prank(co4);
        governor.approveCollaboration(proposalId);
        vm.prank(co5);
        governor.approveCollaboration(proposalId);
        vm.warp(block.timestamp + 1);

        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.warp(block.timestamp + VOTING_PERIOD + 1);

        governor.executeProposal(proposalId);

        // Profit of 49 wei of USDC. perfFeeBps=2000 => agentFee = 9.
        // 9 * 100 / 10000 = 0 → each active co-prop floored at 1 wei.
        // 5 co-props * 1 wei = 5 wei distributed; lead gets agentFee - 5 = 4 wei.
        usdc.mint(address(vault), 49);

        uint256 leadBefore = usdc.balanceOf(leadAgent);
        uint256 co1Before = usdc.balanceOf(coAgent1);
        vm.prank(leadAgent);
        governor.settleProposal(proposalId);

        assertEq(usdc.balanceOf(coAgent1), co1Before + 1, "co1 floored at 1 wei");
        assertEq(usdc.balanceOf(leadAgent) - leadBefore, 4, "lead gets remainder 4 wei");
    }

    /// @dev Deregistered co-proposers with splits that round to zero are
    ///      fine — the `active && share == 0` guard only targets currently
    ///      registered agents. This preserves the existing skip-path.
    function test_coProposerShare_deregisteredGetsZeroOk() public {
        uint256 proposalId = _createAndExecuteCollabProposal();

        // Deregister coAgent2 — its share is now forfeit, routed to the lead.
        vm.prank(owner);
        vault.removeAgent(coAgent2);

        // Small profit: 49 wei. perfFeeBps=2000 => agentFee=9.
        //   coAgent1 (3000 bps, still active): 9 * 3000 / 10000 = 2
        //   coAgent2 (1000 bps, DEREGISTERED): 9 * 1000 / 10000 = 0 → skipped (no revert)
        //   lead: remainder = 9 - 2 = 7
        usdc.mint(address(vault), 49);

        uint256 leadBalBefore = usdc.balanceOf(leadAgent);
        uint256 co1BalBefore = usdc.balanceOf(coAgent1);
        uint256 co2BalBefore = usdc.balanceOf(coAgent2);

        vm.prank(leadAgent);
        governor.settleProposal(proposalId);

        assertEq(usdc.balanceOf(coAgent1), co1BalBefore + 2, "active co-prop gets non-zero share");
        assertEq(usdc.balanceOf(coAgent2), co2BalBefore, "deregistered co-prop skipped even with zero share");
        assertGt(usdc.balanceOf(leadAgent), leadBalBefore, "lead absorbs deregistered residual");
    }

    // ==================== VALIDATION ====================

    function test_validation_leadSplitBelow10Percent() public {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](2);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 5000});
        coProps[1] = ISyndicateGovernor.CoProposer({agent: coAgent2, splitBps: 4100});

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.LeadSplitTooLow.selector);
        governor.propose(
            address(vault), "ipfs://test", 2000, 7 days, _simpleExecuteCalls(), _simpleSettlementCalls(), coProps
        );
    }

    function test_validation_splitTooLow() public {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](1);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 50});

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.SplitTooLow.selector);
        governor.propose(
            address(vault), "ipfs://test", 2000, 7 days, _simpleExecuteCalls(), _simpleSettlementCalls(), coProps
        );
    }

    function test_validation_tooManyCoProposers() public {
        address co3 = makeAddr("co3");
        address co4 = makeAddr("co4");
        address co5 = makeAddr("co5");
        address co6 = makeAddr("co6");
        vm.startPrank(owner);
        vault.registerAgent(agentRegistry.mint(co3), co3);
        vault.registerAgent(agentRegistry.mint(co4), co4);
        vault.registerAgent(agentRegistry.mint(co5), co5);
        vault.registerAgent(agentRegistry.mint(co6), co6);
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
        governor.propose(
            address(vault), "ipfs://test", 2000, 7 days, _simpleExecuteCalls(), _simpleSettlementCalls(), coProps
        );
    }

    function test_validation_unregisteredAgent() public {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](1);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: random, splitBps: 3000});

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.NotRegisteredAgent.selector);
        governor.propose(
            address(vault), "ipfs://test", 2000, 7 days, _simpleExecuteCalls(), _simpleSettlementCalls(), coProps
        );
    }

    function test_validation_duplicateCoProposer() public {
        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](2);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 3000});
        coProps[1] = ISyndicateGovernor.CoProposer({agent: coAgent1, splitBps: 2000});

        vm.prank(leadAgent);
        vm.expectRevert(ISyndicateGovernor.DuplicateCoProposer.selector);
        governor.propose(
            address(vault), "ipfs://test", 2000, 7 days, _simpleExecuteCalls(), _simpleSettlementCalls(), coProps
        );
    }
}
