// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";

import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {ISyndicateVault} from "../../src/interfaces/ISyndicateVault.sol";
import {GuardianRegistry} from "../../src/GuardianRegistry.sol";
import {IGuardianRegistry} from "../../src/interfaces/IGuardianRegistry.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "../mocks/MockAgentRegistry.sol";

/// @title GuardianReviewLifecycle.t
/// @notice End-to-end tests for the Task 25 guardian-review proposal lifecycle.
///         Drives propose → vote → GuardianReview → Approved/Rejected across a
///         real governor + registry with a staked guardian cohort.
contract GuardianReviewLifecycleTest is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    GuardianRegistry public registry;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    ERC20Mock public wood;
    ERC20Mock public targetToken;
    MockAgentRegistry public agentRegistry;

    address public owner = makeAddr("owner");
    address public agent = makeAddr("agent");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public random = makeAddr("random");

    // Five guardians — each above the min-stake floor and together well above the
    // 50k MIN_COHORT_STAKE_AT_OPEN floor so the review path runs.
    address public g1 = makeAddr("guardian1");
    address public g2 = makeAddr("guardian2");
    address public g3 = makeAddr("guardian3");
    address public g4 = makeAddr("guardian4");
    address public g5 = makeAddr("guardian5");
    address public factoryEoa; // test contract impersonates factory

    uint256 public agentNftId;

    // Governor / registry params
    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant COOLDOWN_PERIOD = 1 days;
    uint256 constant PARAM_CHANGE_DELAY = 1 days;

    uint256 constant MIN_GUARDIAN_STAKE = 10_000e18;
    uint256 constant MIN_OWNER_STAKE = 10_000e18;
    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant BLOCK_QUORUM_BPS = 3000; // 30%
    uint256 constant GUARDIAN_STAKE = 20_000e18; // 5 × 20k = 100k cohort

    function setUp() public {
        factoryEoa = address(this);

        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        targetToken = new ERC20Mock("Target", "TGT", 18);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();
        agentNftId = agentRegistry.mint(agent);

        // Vault
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

        // Governor
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
                    maxStrategyDuration: 30 days,
                    parameterChangeDelay: PARAM_CHANGE_DELAY,
                    protocolFeeBps: 0,
                    protocolFeeRecipient: address(0)
                }))
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        vm.prank(owner);
        governor.addVault(address(vault));

        // Registry (factoryEoa = test contract so we can bind owner stake)
        GuardianRegistry regImpl = new GuardianRegistry();
        bytes memory regInit = abi.encodeCall(
            GuardianRegistry.initialize,
            (
                owner,
                address(governor),
                factoryEoa,
                address(wood),
                MIN_GUARDIAN_STAKE,
                MIN_OWNER_STAKE,
                0, // ownerStakeTvlBps — 0 so bond == floor
                7 days,
                REVIEW_PERIOD,
                BLOCK_QUORUM_BPS
            )
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(regImpl), regInit)));

        // Wire registry into governor via Task 25's one-time initializer.
        vm.prank(owner);
        governor.initializeGuardianRegistry(address(registry));

        // LPs
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
        vm.warp(vm.getBlockTimestamp() + 1);

        // Owner prepares + binds stake.
        wood.mint(owner, 100_000e18);
        vm.prank(owner);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(owner);
        registry.prepareOwnerStake(MIN_OWNER_STAKE);
        vm.prank(factoryEoa);
        registry.bindOwnerStake(owner, address(vault));

        // Guardians stake — five × 20k = 100k (well above 50k MIN_COHORT_STAKE_AT_OPEN).
        _stakeGuardian(g1, GUARDIAN_STAKE, 1);
        _stakeGuardian(g2, GUARDIAN_STAKE, 2);
        _stakeGuardian(g3, GUARDIAN_STAKE, 3);
        _stakeGuardian(g4, GUARDIAN_STAKE, 4);
        _stakeGuardian(g5, GUARDIAN_STAKE, 5);
    }

    // ──────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────

    function _stakeGuardian(address who, uint256 amount, uint256 agentId) internal {
        wood.mint(who, amount);
        vm.prank(who);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(who);
        registry.stakeAsGuardian(amount, agentId);
    }

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }

    function _execCalls() internal view returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
    }

    function _settleCalls() internal view returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });
    }

    function _propose() internal returns (uint256 proposalId) {
        vm.prank(agent);
        proposalId = governor.propose(
            address(vault), "ipfs://review-lifecycle", 1000, 7 days, _execCalls(), _settleCalls(), _emptyCoProposers()
        );
    }

    function _voteFor(uint256 pid) internal {
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(lp1);
        governor.vote(pid, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(pid, ISyndicateGovernor.VoteType.For);
    }

    // ──────────────────────────────────────────────────────────────
    // 25.9 Scenarios
    // ──────────────────────────────────────────────────────────────

    /// @notice Full lifecycle — post-vote → GuardianReview → Approved (no blocks)
    ///         → execute → settle. No slashing happens.
    function test_lifecycle_happyPath_survivesReview_executes_settles() public {
        uint256 pid = _propose();
        _voteFor(pid);

        // Vote ends → state is GuardianReview until the review window elapses.
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        assertEq(
            uint256(governor.getProposalState(pid)),
            uint256(ISyndicateGovernor.ProposalState.GuardianReview),
            "state should be GuardianReview after voteEnd"
        );

        // Keeper opens the review.
        registry.openReview(pid);

        // Optional Approve votes — don't matter for the outcome, but exercise the path.
        vm.prank(g1);
        registry.voteOnProposal(pid, IGuardianRegistry.GuardianVoteType.Approve);
        vm.prank(g2);
        registry.voteOnProposal(pid, IGuardianRegistry.GuardianVoteType.Approve);

        // Review ends → state resolves to Approved (no blocks).
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        assertEq(
            uint256(governor.getProposalState(pid)),
            uint256(ISyndicateGovernor.ProposalState.GuardianReview),
            "before resolveReview, the view path still sees GuardianReview"
        );

        // Execute drives `_resolveState` which calls `resolveReview`.
        governor.executeProposal(pid);
        assertEq(
            uint256(governor.getProposal(pid).state),
            uint256(ISyndicateGovernor.ProposalState.Executed),
            "executed after review resolves with no blocks"
        );

        // Approvers keep their stake — no slashing on the happy path.
        assertEq(registry.guardianStake(g1), GUARDIAN_STAKE);
        assertEq(registry.guardianStake(g2), GUARDIAN_STAKE);

        // Settle after duration.
        vm.warp(vm.getBlockTimestamp() + 7 days + 1);
        governor.settleProposal(pid);
        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Settled));
    }

    /// @notice Block quorum hit → proposal rejected and approvers slashed.
    function test_lifecycle_blockQuorum_rejects_slashesApprovers() public {
        uint256 pid = _propose();
        _voteFor(pid);

        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReview(pid);

        // g1, g2 Approve; g3, g4, g5 Block.
        // Total stake at open = 100k. Block weight = 60k → 60% ≥ 30% quorum → BLOCKED.
        vm.prank(g1);
        registry.voteOnProposal(pid, IGuardianRegistry.GuardianVoteType.Approve);
        vm.prank(g2);
        registry.voteOnProposal(pid, IGuardianRegistry.GuardianVoteType.Approve);
        vm.prank(g3);
        registry.voteOnProposal(pid, IGuardianRegistry.GuardianVoteType.Block);
        vm.prank(g4);
        registry.voteOnProposal(pid, IGuardianRegistry.GuardianVoteType.Block);
        vm.prank(g5);
        registry.voteOnProposal(pid, IGuardianRegistry.GuardianVoteType.Block);

        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        // Resolve review directly on the registry (permissionless). This slashes
        // approvers and caches `blocked = true`.
        bool blocked = registry.resolveReview(pid);
        assertTrue(blocked, "review resolved as blocked");

        // Approvers were slashed; blockers untouched.
        assertEq(registry.guardianStake(g1), 0, "g1 slashed");
        assertEq(registry.guardianStake(g2), 0, "g2 slashed");
        assertEq(registry.guardianStake(g3), GUARDIAN_STAKE, "g3 untouched");
        assertEq(registry.guardianStake(g4), GUARDIAN_STAKE, "g4 untouched");
        assertEq(registry.guardianStake(g5), GUARDIAN_STAKE, "g5 untouched");

        // Governor view now maps to Rejected via the cached registry resolution.
        assertEq(
            uint256(governor.getProposalState(pid)),
            uint256(ISyndicateGovernor.ProposalState.Rejected),
            "governor view reflects blocked review"
        );

        // executeProposal reverts because the proposal is Rejected, not Approved.
        vm.expectRevert(ISyndicateGovernor.ProposalNotApproved.selector);
        governor.executeProposal(pid);
    }

    /// @notice When the guardian cohort is below MIN_COHORT_STAKE_AT_OPEN at
    ///         openReview time, the review auto-resolves to Approved with zero
    ///         slashing regardless of how any vote shakes out.
    function test_lifecycle_cohortTooSmall_autoApproves_noSlashing() public {
        // Drain the cohort below 50k: request unstake from 3 guardians so only
        // g1 + g2 remain active (40k < 50k).
        vm.prank(g3);
        registry.requestUnstakeGuardian();
        vm.prank(g4);
        registry.requestUnstakeGuardian();
        vm.prank(g5);
        registry.requestUnstakeGuardian();

        uint256 pid = _propose();
        _voteFor(pid);

        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReview(pid);

        (,,, bool cohortTooSmall) = registry.getReviewState(pid);
        assertTrue(cohortTooSmall, "cohort flagged as too small");

        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        // No slashing — proposal should go straight to Approved then Executed.
        governor.executeProposal(pid);
        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Executed));
        assertEq(registry.guardianStake(g1), GUARDIAN_STAKE, "g1 untouched");
        assertEq(registry.guardianStake(g2), GUARDIAN_STAKE, "g2 untouched");
    }

    /// @notice Owner cannot veto a proposal that has transitioned out of Pending.
    function test_vetoProposal_inGuardianReview_reverts() public {
        uint256 pid = _propose();
        _voteFor(pid);

        // Move into the GuardianReview window.
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        assertEq(uint256(governor.getProposalState(pid)), uint256(ISyndicateGovernor.ProposalState.GuardianReview));

        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.ProposalNotCancellable.selector);
        governor.vetoProposal(pid);
    }

    /// @notice Owner cannot emergencyCancel once the proposal is Approved.
    function test_emergencyCancel_inApproved_reverts() public {
        uint256 pid = _propose();
        _voteFor(pid);

        // Move past review → Approved.
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReview(pid);
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        // Drive the registry resolution via the mutating resolver on the governor
        // by calling a state-changing path. `vetoProposal` is cheap — attempt it
        // so the state is committed as Approved/Rejected; we expect it to revert.
        // Simpler: just read view and assert, then assert emergencyCancel reverts.
        // View path keeps state as GuardianReview until resolve; emergencyCancel
        // calls _resolveState which will resolve and return Approved.
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.ProposalNotCancellable.selector);
        governor.emergencyCancel(pid);
    }
}
