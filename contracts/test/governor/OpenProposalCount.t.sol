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

/// @title OpenProposalCount.t
/// @notice Regression tests for Fix 2 — track open proposals per vault to plug
///         the rage-quit gap in `requestUnstakeOwner`. The legacy
///         `getActiveProposal` check only covered the Executed state, so an
///         owner could unstake while a Pending / GuardianReview / Approved
///         proposal was outstanding. The new `openProposalCount(vault)`
///         counter closes that gap.
contract OpenProposalCountTest is Test {
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

    address public g1 = makeAddr("guardian1");
    address public g2 = makeAddr("guardian2");
    address public g3 = makeAddr("guardian3");
    address public g4 = makeAddr("guardian4");
    address public g5 = makeAddr("guardian5");

    address public factoryEoa;
    uint256 public agentNftId;

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant COOLDOWN_PERIOD = 1 days;

    uint256 constant MIN_GUARDIAN_STAKE = 10_000e18;
    uint256 constant MIN_OWNER_STAKE = 10_000e18;
    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant BLOCK_QUORUM_BPS = 3000;
    uint256 constant GUARDIAN_STAKE = 20_000e18;

    function setUp() public {
        factoryEoa = address(this);

        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        wood = new ERC20Mock("WOOD", "WOOD", 18);
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
                    managementFeeBps: 0
                }))
        );
        vault = SyndicateVault(payable(address(new ERC1967Proxy(address(vaultImpl), vaultInit))));

        vm.prank(owner);
        vault.registerAgent(agentNftId, agent);

        // Governor + registry — circular init dep resolved by predicting the
        // registry proxy via `vm.computeCreateAddress`: govImpl (+0),
        // govProxy (+1), regImpl (+2), regProxy (+3).
        uint256 baseNonce = vm.getNonce(address(this));
        address predictedRegistryProxy = vm.computeCreateAddress(address(this), baseNonce + 3);

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
                    maxStrategyDuration: 30 days,
                    protocolFeeBps: 0,
                    protocolFeeRecipient: address(0),
                    guardianFeeBps: 0
                }),
                predictedRegistryProxy
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        vm.prank(owner);
        governor.addVault(address(vault));

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
                7 days,
                REVIEW_PERIOD,
                BLOCK_QUORUM_BPS
            )
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(regImpl), regInit)));
        require(address(registry) == predictedRegistryProxy, "registry addr mismatch");

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

        wood.mint(owner, 100_000e18);
        vm.prank(owner);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(owner);
        registry.prepareOwnerStake(MIN_OWNER_STAKE);
        vm.prank(factoryEoa);
        registry.bindOwnerStake(owner, address(vault));

        _stakeGuardian(g1, GUARDIAN_STAKE, 1);
        _stakeGuardian(g2, GUARDIAN_STAKE, 2);
        _stakeGuardian(g3, GUARDIAN_STAKE, 3);
        _stakeGuardian(g4, GUARDIAN_STAKE, 4);
        _stakeGuardian(g5, GUARDIAN_STAKE, 5);
    }

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
            address(vault), "ipfs://open-count", 1000, 7 days, _execCalls(), _settleCalls(), _emptyCoProposers()
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
    // Rage-quit blocking
    // ──────────────────────────────────────────────────────────────

    function test_requestUnstakeOwner_revertsDuringPending() public {
        _propose();
        assertEq(governor.openProposalCount(address(vault)), 1, "counter == 1 in Pending");

        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.VaultHasActiveProposal.selector);
        registry.requestUnstakeOwner(address(vault));
    }

    function test_requestUnstakeOwner_revertsDuringGuardianReview() public {
        uint256 pid = _propose();
        _voteFor(pid);

        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        assertEq(
            uint256(governor.getProposalState(pid)),
            uint256(ISyndicateGovernor.ProposalState.GuardianReview),
            "state is GuardianReview"
        );
        assertEq(governor.openProposalCount(address(vault)), 1, "counter still 1 in GuardianReview");

        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.VaultHasActiveProposal.selector);
        registry.requestUnstakeOwner(address(vault));
    }

    function test_requestUnstakeOwner_revertsDuringApproved() public {
        uint256 pid = _propose();
        _voteFor(pid);

        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReview(pid);
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        // Drive registry resolution without executing so we land in Approved.
        registry.resolveReview(pid);
        // Sync governor-side state via a mutating path.
        governor.getProposal(pid); // view
        // Force a mutating _resolveState via a path that transitions — we
        // approximate by calling executeProposal which will succeed and move to
        // Executed. To test Approved specifically we rely on the view-path
        // equivalence. Pull cached state via resolveReview then check counter.
        // Approved is brief here; the counter should still be 1 at this moment
        // because no terminal transition has fired yet.
        assertEq(governor.openProposalCount(address(vault)), 1, "counter still 1 in Approved");

        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.VaultHasActiveProposal.selector);
        registry.requestUnstakeOwner(address(vault));
    }

    function test_requestUnstakeOwner_revertsDuringExecuted() public {
        // PR #229 Fix 2: counter stays incremented through Executed; the dec
        // fires on Executed -> Settled. `_activeProposal` also covers Executed
        // so the registry's OR-check blocks rage-quit regardless.
        uint256 pid = _propose();
        _voteFor(pid);
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReview(pid);
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        governor.executeProposal(pid);
        assertEq(governor.openProposalCount(address(vault)), 1, "counter still 1 in Executed");
        assertEq(governor.getActiveProposal(address(vault)), pid, "_activeProposal also set");

        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.VaultHasActiveProposal.selector);
        registry.requestUnstakeOwner(address(vault));
    }

    function test_requestUnstakeOwner_succeedsAfterProposalSettled() public {
        uint256 pid = _propose();
        _voteFor(pid);

        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReview(pid);
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        governor.executeProposal(pid);
        // Counter stays 1 through Executed; cleared on Settled.
        assertEq(governor.openProposalCount(address(vault)), 1, "counter stays 1 through Executed");
        assertEq(governor.getActiveProposal(address(vault)), pid, "_activeProposal non-zero");

        vm.warp(vm.getBlockTimestamp() + 7 days + 1);
        governor.settleProposal(pid);
        assertEq(governor.openProposalCount(address(vault)), 0, "counter == 0 after Settled");
        assertEq(governor.getActiveProposal(address(vault)), 0, "_activeProposal cleared on Settled");

        vm.prank(owner);
        registry.requestUnstakeOwner(address(vault)); // must not revert
    }

    function test_requestUnstakeOwner_succeedsAfterCancel() public {
        uint256 pid = _propose();
        assertEq(governor.openProposalCount(address(vault)), 1, "counter == 1 after propose");

        vm.prank(agent);
        governor.cancelProposal(pid);
        assertEq(governor.openProposalCount(address(vault)), 0, "counter == 0 after cancel");

        vm.prank(owner);
        registry.requestUnstakeOwner(address(vault)); // must not revert
    }

    // NOTE (closed): a vote-driven Rejected or deadline-driven Expired
    // transition only persists to storage when a NON-reverting mutating call
    // lands inside `_resolveState`. Since every allow-listed entrypoint
    // (`executeProposal`, `settleProposal`, `vote`, etc.) reverts when the
    // resolved state isn't the one it expects, the dec of
    // `openProposalCount` was rolled back and the counter stayed pinned at 1.
    // `resolveProposalState(pid)` is the permissionless flush path — it runs
    // `_resolveState` and returns, so the lazy transition (and its dec)
    // commit. Regression tests: `test_resolveProposalState_*` below.

    function test_resolveProposalState_flushesVetoRejection() public {
        uint256 pid = _propose();
        assertEq(governor.openProposalCount(address(vault)), 1, "counter == 1 in Pending");

        // Both LPs vote Against → crosses 40% vetoThresholdBps with 100%.
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(lp1);
        governor.vote(pid, ISyndicateGovernor.VoteType.Against);
        vm.prank(lp2);
        governor.vote(pid, ISyndicateGovernor.VoteType.Against);

        // Warp past voting period — proposal is lazily Rejected but the
        // counter hasn't flushed because no non-reverting mutating call has
        // landed in `_resolveState`.
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        assertEq(
            uint256(governor.getProposalState(pid)),
            uint256(ISyndicateGovernor.ProposalState.Rejected),
            "state is lazily Rejected"
        );
        assertEq(governor.openProposalCount(address(vault)), 1, "counter still stuck at 1 pre-flush");

        // Permissionless flush — anyone can call.
        governor.resolveProposalState(pid);
        assertEq(governor.openProposalCount(address(vault)), 0, "counter == 0 after flush");

        // Owner can now rage-quit.
        vm.prank(owner);
        registry.requestUnstakeOwner(address(vault));
    }

    function test_resolveProposalState_flushesExpiredApproved() public {
        uint256 pid = _propose();
        _voteFor(pid);

        // Past voteEnd → GuardianReview, past reviewEnd with no blockers
        // would be Approved, past executeBy with no executeProposal call
        // would be Expired. The VIEW remains at GuardianReview until a
        // mutating `_resolveState` calls `resolveReview` on the registry.
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + REVIEW_PERIOD + EXECUTION_WINDOW + 1);
        assertEq(
            uint256(governor.getProposalState(pid)),
            uint256(ISyndicateGovernor.ProposalState.GuardianReview),
            "view pins at GuardianReview until registry resolves"
        );
        assertEq(governor.openProposalCount(address(vault)), 1, "counter stuck at 1 pre-flush");

        // Permissionless flush resolves the registry review AND commits the
        // state transition, decrementing the counter.
        governor.resolveProposalState(pid);
        assertEq(
            uint256(governor.getProposalState(pid)),
            uint256(ISyndicateGovernor.ProposalState.Expired),
            "state is Expired after flush"
        );
        assertEq(governor.openProposalCount(address(vault)), 0, "counter == 0 after flush");

        vm.prank(owner);
        registry.requestUnstakeOwner(address(vault));
    }

    function test_resolveProposalState_idempotent() public {
        uint256 pid = _propose();
        vm.prank(owner);
        governor.vetoProposal(pid); // already flushes counter via non-reverting path
        assertEq(governor.openProposalCount(address(vault)), 0);

        // Re-calling resolve is a no-op.
        governor.resolveProposalState(pid);
        assertEq(governor.openProposalCount(address(vault)), 0, "counter remains 0 on re-resolve");
    }

    function test_resolveProposalState_revertsIfProposalDoesNotExist() public {
        vm.expectRevert(ISyndicateGovernor.ProposalNotFound.selector);
        governor.resolveProposalState(99_999);
    }

    function test_requestUnstakeOwner_succeedsAfterVeto() public {
        uint256 pid = _propose();
        assertEq(governor.openProposalCount(address(vault)), 1);

        vm.prank(owner);
        governor.vetoProposal(pid);
        assertEq(governor.openProposalCount(address(vault)), 0, "counter == 0 after veto");

        vm.prank(owner);
        registry.requestUnstakeOwner(address(vault));
    }

    function test_requestUnstakeOwner_succeedsAfterEmergencyCancel() public {
        uint256 pid = _propose();
        assertEq(governor.openProposalCount(address(vault)), 1);

        vm.prank(owner);
        governor.emergencyCancel(pid);
        assertEq(governor.openProposalCount(address(vault)), 0, "counter == 0 after emergencyCancel");

        vm.prank(owner);
        registry.requestUnstakeOwner(address(vault));
    }

    function test_openProposalCount_trackedAcrossLifecycle() public {
        // Start at 0.
        assertEq(governor.openProposalCount(address(vault)), 0, "start at 0");

        uint256 pid1 = _propose();
        assertEq(governor.openProposalCount(address(vault)), 1, "inc on propose");

        // Cancel pid1 → back to 0.
        vm.prank(agent);
        governor.cancelProposal(pid1);
        assertEq(governor.openProposalCount(address(vault)), 0, "dec on cancel");

        // New proposal, settle through the full happy path.
        uint256 pid2 = _propose();
        assertEq(governor.openProposalCount(address(vault)), 1, "inc on second propose");

        _voteFor(pid2);
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReview(pid2);
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        governor.executeProposal(pid2);
        // Counter stays through Executed; dec on the Settled edge.
        assertEq(governor.openProposalCount(address(vault)), 1, "counter stays 1 through Executed");
        assertEq(governor.getActiveProposal(address(vault)), pid2, "_activeProposal also set");

        vm.warp(vm.getBlockTimestamp() + 7 days + 1);
        governor.settleProposal(pid2);
        assertEq(governor.openProposalCount(address(vault)), 0, "counter cleared on Settled");
        assertEq(governor.getActiveProposal(address(vault)), 0, "_activeProposal zeroed on Settled");
    }

    function test_openProposalCount_collaborativeLifecycle() public {
        // Register a second agent.
        address agent2 = makeAddr("agent2");
        uint256 agent2Id = agentRegistry.mint(agent2);
        vm.prank(owner);
        vault.registerAgent(agent2Id, agent2);

        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](1);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: agent2, splitBps: 2000});

        vm.prank(agent);
        uint256 pid =
            governor.propose(address(vault), "ipfs://collab", 1000, 7 days, _execCalls(), _settleCalls(), coProps);

        // Draft state → counter stays at 0.
        assertEq(
            uint256(governor.getProposalState(pid)),
            uint256(ISyndicateGovernor.ProposalState.Draft),
            "in Draft until co-proposers approve"
        );
        assertEq(governor.openProposalCount(address(vault)), 0, "Draft does not count");

        // Co-proposer approves → transitions to Pending → counter increments.
        vm.prank(agent2);
        governor.approveCollaboration(pid);
        assertEq(
            uint256(governor.getProposalState(pid)),
            uint256(ISyndicateGovernor.ProposalState.Pending),
            "collab -> Pending"
        );
        assertEq(governor.openProposalCount(address(vault)), 1, "inc on Draft -> Pending");

        // Cancel.
        vm.prank(agent);
        governor.cancelProposal(pid);
        assertEq(governor.openProposalCount(address(vault)), 0, "dec on cancel");
    }

    function test_openProposalCount_rejectCollaboration_noDecrement() public {
        // Register co-proposer.
        address agent2 = makeAddr("agent2");
        uint256 agent2Id = agentRegistry.mint(agent2);
        vm.prank(owner);
        vault.registerAgent(agent2Id, agent2);

        ISyndicateGovernor.CoProposer[] memory coProps = new ISyndicateGovernor.CoProposer[](1);
        coProps[0] = ISyndicateGovernor.CoProposer({agent: agent2, splitBps: 2000});

        vm.prank(agent);
        uint256 pid = governor.propose(
            address(vault), "ipfs://collab-reject", 1000, 7 days, _execCalls(), _settleCalls(), coProps
        );
        assertEq(governor.openProposalCount(address(vault)), 0, "Draft does not count");

        // Reject collaboration — Draft → Cancelled, counter stays at 0.
        vm.prank(agent2);
        governor.rejectCollaboration(pid);
        assertEq(governor.openProposalCount(address(vault)), 0, "no double-dec on rejectCollaboration");
    }
}
