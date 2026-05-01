// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";

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

/// @title GovernorEmergency.t
/// @notice Tests for the Task 24 guardian-review emergency settle lifecycle.
///         Covers `unstick`, `emergencySettleWithCalls`, `cancelEmergencySettle`,
///         `finalizeEmergencySettle` against a real `GuardianRegistry` proxy.
///         The registry is wired at governor init-time, and
///         `_createExecutedProposal` drives the full vote → review → approve
///         flow so `executeProposal` runs from the Approved state.
contract GovernorEmergencyTest is Test {
    using stdStorage for StdStorage;

    // ── Contracts ──
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    GuardianRegistry public registry;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    ERC20Mock public wood;
    ERC20Mock public targetToken;
    MockAgentRegistry public agentRegistry;

    // ── Actors ──
    address public owner = makeAddr("owner");
    address public agent = makeAddr("agent");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");
    address public random = makeAddr("random");
    address public guardianA = makeAddr("guardianA");
    address public guardianB = makeAddr("guardianB");
    // The test contract impersonates the factory for owner-stake binding.
    address public factoryEoa;

    uint256 public agentNftId;

    // ── Params ──
    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant COOLDOWN_PERIOD = 1 days;

    uint256 constant MIN_GUARDIAN_STAKE = 10_000e18;
    uint256 constant MIN_OWNER_STAKE = 10_000e18;
    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant BLOCK_QUORUM_BPS = 3000; // 30%
    // Both guardians exceed MIN_COHORT_STAKE_AT_OPEN (50k WOOD) via registry constant.
    uint256 constant GUARDIAN_STAKE = 30_000e18;

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

        // Registry — governor is the real governor so `openEmergency` passes
        // the onlyGovernor check. The test contract acts as factory so we can bind
        // owner stake without standing up the full factory. Must land at
        // predictedRegistryProxy — `require` below catches nonce drift.
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

        // WOOD balances
        wood.mint(owner, 100_000e18);
        wood.mint(guardianA, 100_000e18);
        wood.mint(guardianB, 100_000e18);

        // Owner prepares & binds stake via the factory path.
        vm.prank(owner);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(owner);
        registry.prepareOwnerStake(MIN_OWNER_STAKE);
        vm.prank(factoryEoa);
        registry.bindOwnerStake(owner, address(vault));

        // Guardians stake so a cohort exists (≥ MIN_COHORT_STAKE_AT_OPEN = 50k WOOD).
        vm.prank(guardianA);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(guardianA);
        registry.stakeAsGuardian(GUARDIAN_STAKE, 1);

        vm.prank(guardianB);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(guardianB);
        registry.stakeAsGuardian(GUARDIAN_STAKE, 2);
    }

    // ──────────────────────────────────────────────────────────────
    // Helpers
    // ──────────────────────────────────────────────────────────────

    function _emptyCoProposers() internal pure returns (ISyndicateGovernor.CoProposer[] memory) {
        return new ISyndicateGovernor.CoProposer[](0);
    }

    function _execCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 50_000e6)), value: 0
        });
        return calls;
    }

    function _settleCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });
        return calls;
    }

    function _customCalls() internal view returns (BatchExecutorLib.Call[] memory) {
        // Owner-supplied alternative settlement: set allowance to 0 via a different path
        // (same semantic effect as _settleCalls, but constructed to produce a distinct
        // hash when the caller feeds a deliberately mismatched input).
        BatchExecutorLib.Call[] memory calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
        });
        return calls;
    }

    function _createExecutedProposal(uint256 duration) internal returns (uint256 proposalId) {
        vm.prank(agent);
        proposalId = governor.propose(
            address(vault), "ipfs://emergency", 1000, duration, _execCalls(), _settleCalls(), _emptyCoProposers()
        );
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.For);
        // Voting ends → proposal enters GuardianReview. Open the review so guardians
        // could vote if they wanted; skip the review window and resolve with no
        // blocks → Approved. Then execute.
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReview(proposalId);
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        governor.executeProposal(proposalId);
    }

    /// @dev Zeroes a vault's bound owner stake via stdstore, simulating a slashed
    ///      or grace-period owner. Touches `_ownerStakes[vault].stakedAmount` (the
    ///      `OwnerStake.stakedAmount` uint128 lives in slot 0 of the struct).
    function _zeroOwnerStake(address v) internal {
        stdstore.target(address(registry)).sig("ownerStake(address)").with_key(v).checked_write(uint256(0));
    }

    // ──────────────────────────────────────────────────────────────
    // unstick
    // ──────────────────────────────────────────────────────────────

    function test_unstick_afterDuration_runsPrecommitted() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        vm.prank(owner);
        governor.unstick(pid);

        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertFalse(vault.redemptionsLocked());
    }

    function test_unstick_beforeDuration_reverts() public {
        uint256 pid = _createExecutedProposal(7 days);
        // 1 second before duration elapsed
        vm.warp(vm.getBlockTimestamp() + 7 days - 1);
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.StrategyDurationNotElapsed.selector);
        governor.unstick(pid);
    }

    function test_unstick_notVaultOwner_reverts() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(random);
        vm.expectRevert(ISyndicateGovernor.NotVaultOwner.selector);
        governor.unstick(pid);
    }

    function test_unstick_doesNotRequireOwnerStake() public {
        // Zero the owner stake — `unstick` MUST still succeed because the
        // pre-committed settlement calls were governance-approved.
        _zeroOwnerStake(address(vault));
        assertEq(registry.ownerStake(address(vault)), 0);

        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(owner);
        governor.unstick(pid);
        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Settled));
    }

    // ──────────────────────────────────────────────────────────────
    // emergencySettleWithCalls
    // ──────────────────────────────────────────────────────────────

    function test_emergencySettleWithCalls_opensReviewWindow() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        BatchExecutorLib.Call[] memory calls = _customCalls();
        bytes32 expectedHash = keccak256(abi.encode(calls));

        vm.expectEmit(true, true, false, true, address(governor));
        emit ISyndicateGovernor.EmergencySettleProposed(
            pid, owner, expectedHash, uint64(vm.getBlockTimestamp() + REVIEW_PERIOD)
        );
        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, calls);
    }

    function test_emergencySettleWithCalls_revertsIfInsufficientBond() public {
        _zeroOwnerStake(address(vault));
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.OwnerBondInsufficient.selector);
        governor.emergencySettleWithCalls(pid, _customCalls());
    }

    // ──────────────────────────────────────────────────────────────
    // cancelEmergencySettle
    // ──────────────────────────────────────────────────────────────

    function test_cancelEmergencySettle_clearsState() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());

        // Cancel clears registry state so the emergency review is no longer open.
        vm.expectEmit(true, true, false, false, address(governor));
        emit ISyndicateGovernor.EmergencySettleCancelled(pid, owner);
        vm.prank(owner);
        governor.cancelEmergencySettle(pid);

        assertFalse(registry.isEmergencyOpen(pid), "emergency review closed after cancel");

        // finalizeEmergencySettle reverts because the review was resolved by cancel.
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.ReviewNotReadyForResolve.selector);
        governor.finalizeEmergencySettle(pid);
    }

    /// @notice Regression for PR #229 critical fix: cancelling an emergency
    ///         settle must also invalidate the registry-side review so stale
    ///         block votes cannot slash the owner.
    function test_cancelEmergencySettle_preventsSlashingStaleVotes() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        // Owner opens emergency settle.
        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());

        // Both guardians hit block quorum (60k/60k = 100% ≥ 30%).
        vm.prank(guardianA);
        registry.voteBlockEmergencySettle(pid);
        vm.prank(guardianB);
        registry.voteBlockEmergencySettle(pid);

        // Owner cancels before reviewEnd.
        vm.prank(owner);
        governor.cancelEmergencySettle(pid);

        uint256 stakeBefore = registry.ownerStake(address(vault));
        assertEq(stakeBefore, MIN_OWNER_STAKE);

        // Emergency review is closed — no permissionless resolve possible.
        assertFalse(registry.isEmergencyOpen(pid), "emergency closed after cancel");

        // Owner stake untouched.
        assertEq(registry.ownerStake(address(vault)), stakeBefore, "owner stake NOT slashed");
    }

    /// @notice Regression for PR #229 critical fix: after cancel, re-opening
    ///         an emergency review must start fresh — prior-round block votes
    ///         must not leak into the new round, and guardians can vote again
    ///         without an `AlreadyVoted` revert.
    function test_reopenAfterCancel_startsFresh() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        // Round 1: owner opens, guardianA blocks, owner cancels.
        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());
        vm.prank(guardianA);
        registry.voteBlockEmergencySettle(pid);

        vm.prank(owner);
        governor.cancelEmergencySettle(pid);

        // Round 2: owner re-opens. guardianA must be able to vote again
        // (nonce bumped so the prior vote is invisible).
        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());
        vm.prank(guardianA);
        registry.voteBlockEmergencySettle(pid); // must NOT revert AlreadyVoted

        // Only guardianA has voted this round → 30k/60k = 50% ≥ 30% block quorum.
        // Finalize via governor — blocked because guardianA voted block.
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.EmergencySettleBlocked.selector);
        governor.finalizeEmergencySettle(pid);
    }

    // ──────────────────────────────────────────────────────────────
    // finalizeEmergencySettle
    // ──────────────────────────────────────────────────────────────

    function test_finalizeEmergencySettle_notBlocked_executes() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());

        // No guardian block votes cast → blockStakeWeight = 0 → not blocked.
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        vm.expectEmit(true, false, false, false, address(governor));
        emit ISyndicateGovernor.EmergencySettleFinalized(pid, 0);
        vm.prank(owner);
        governor.finalizeEmergencySettle(pid);

        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertFalse(vault.redemptionsLocked());
    }

    function test_finalizeEmergencySettle_blocked_reverts() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());

        // Guardian A + B both vote block (each 30k/60k = 50% → above 30% quorum).
        vm.prank(guardianA);
        registry.voteBlockEmergencySettle(pid);
        vm.prank(guardianB);
        registry.voteBlockEmergencySettle(pid);

        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.EmergencySettleBlocked.selector);
        governor.finalizeEmergencySettle(pid);
    }

    // ──────────────────────────────────────────────────────────────
    // Task 27.B — full-flow emergency settle: blocked slashes owner,
    //              not-blocked finalizes cleanly
    // ──────────────────────────────────────────────────────────────

    /// @notice Cross-contract: owner stakes a bad emergency-settle, guardians
    ///         hit block quorum, `finalizeEmergencySettle` reverts with
    ///         `EmergencySettleBlocked`. Under V2, `finalizeEmergency` is
    ///         `onlyGovernor` so the slash + revert happen atomically — the
    ///         revert rolls back the slash. Owner stake is preserved.
    function test_emergencySettle_blocked_revertsFinalize_ownerNotSlashed() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());

        // guardianA + guardianB both block — total 60k / 60k = 100% ≥ 30%.
        vm.prank(guardianA);
        registry.voteBlockEmergencySettle(pid);
        vm.prank(guardianB);
        registry.voteBlockEmergencySettle(pid);

        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        uint256 ownerStakeBefore = registry.ownerStake(address(vault));
        assertEq(ownerStakeBefore, MIN_OWNER_STAKE, "owner bonded pre-finalize");

        // Finalize reverts with EmergencySettleBlocked. The revert rolls back
        // the slash that `finalizeEmergency` attempted inside the registry.
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.EmergencySettleBlocked.selector);
        governor.finalizeEmergencySettle(pid);

        // Owner stake is preserved — revert rolled back the slash.
        assertEq(registry.ownerStake(address(vault)), ownerStakeBefore, "owner stake preserved");
        assertTrue(registry.hasOwnerStake(address(vault)), "hasOwnerStake still true");

        // Proposal stays in Executed state (not settled).
        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Executed));
    }

    /// @notice No guardians block → `finalizeEmergency` returns false →
    ///         finalize executes the pre-committed bad calls → proposal Settled.
    function test_emergencySettle_notBlocked_finalizes() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        BatchExecutorLib.Call[] memory customCalls = _customCalls();
        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, customCalls);

        // Nobody blocks. Warp past emergency reviewEnd.
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        vm.prank(owner);
        governor.finalizeEmergencySettle(pid);

        assertEq(
            uint256(governor.getProposal(pid).state),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "finalize succeeds when no block quorum"
        );

        // Owner stake untouched — no slashing when review not blocked.
        assertEq(registry.ownerStake(address(vault)), MIN_OWNER_STAKE, "owner stake preserved");
        assertFalse(vault.redemptionsLocked(), "vault unlocked post-settle");
    }

    function test_finalize_afterStandardSettle_reverts() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        BatchExecutorLib.Call[] memory customCalls = _customCalls();
        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, customCalls);

        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        governor.settleProposal(pid);
        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertEq(governor.openProposalCount(address(vault)), 0);

        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.ProposalNotExecuted.selector);
        governor.finalizeEmergencySettle(pid);

        assertEq(governor.openProposalCount(address(vault)), 0);
    }

    /// @notice MS-H2 regression: if `settleProposal` races ahead of an open
    ///         emergency review with block votes, `_finishSettlement` must NOT
    ///         auto-cancel the registry review. The owner cannot dodge the
    ///         slash by racing a standard settle — `resolveEmergencyReview`
    ///         remains callable post-settle and applies the block-quorum slash.
    function test_settleProposal_doesNotCancelOpenEmergencyReview() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        // Owner opens emergency settle with custom calls.
        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());

        // Both guardians vote block (60k/60k = 100% — slashes if resolved).
        vm.prank(guardianA);
        registry.voteBlockEmergencySettle(pid);
        vm.prank(guardianB);
        registry.voteBlockEmergencySettle(pid);

        uint256 stakeBefore = registry.ownerStake(address(vault));
        assertEq(stakeBefore, MIN_OWNER_STAKE, "precondition: owner stake bonded");

        // Race: standard settleProposal fires before reviewEnd.
        governor.settleProposal(pid);
        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Settled));

        // MS-H2: emergency review must STAY open — owner cannot dodge slash by
        // racing a standard settle. `_finishSettlement` no longer auto-cancels.
        assertTrue(registry.isEmergencyOpen(pid), "emergency stays open after standard settle");

        // Owner stake still bonded pre-resolution.
        assertEq(registry.ownerStake(address(vault)), stakeBefore, "owner stake bonded pre-resolve");

        // Anyone can resolve the emergency review at reviewEnd → block-quorum
        // slash applies, owner stake is burned.
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        registry.resolveEmergencyReview(pid);

        assertFalse(registry.isEmergencyOpen(pid), "emergency closed after resolveEmergencyReview");
        assertEq(registry.ownerStake(address(vault)), 0, "owner stake slashed by block quorum");
    }

    function test_emergencySettleWithCalls_callsLengthExceeds_reverts() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        BatchExecutorLib.Call[] memory tooMany = new BatchExecutorLib.Call[](65);
        for (uint256 i = 0; i < 65; i++) {
            tooMany[i] = BatchExecutorLib.Call({
                target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 0)), value: 0
            });
        }

        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.EmergencyTooManyCalls.selector);
        governor.emergencySettleWithCalls(pid, tooMany);
    }

    function test_emergencySettle_reopenWithoutCancel_reverts() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());

        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.EmergencyAlreadyOpen.selector);
        governor.emergencySettleWithCalls(pid, _customCalls());
    }

    function test_cancelEmergencySettle_afterStandardSettle_reverts() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());

        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        governor.settleProposal(pid);

        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.ProposalNotExecuted.selector);
        governor.cancelEmergencySettle(pid);
    }

    // ──────────────────────────────────────────────────────────────
    // Task 7: New tests — registry-owned emergency state
    // ──────────────────────────────────────────────────────────────

    /// @notice Verify `isEmergencyOpen` tracks the full lifecycle:
    ///         false → open → true → cancel → false → re-open → true → finalize → false.
    function test_isEmergencyOpen_lifecycle() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        assertFalse(registry.isEmergencyOpen(pid), "before open");

        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());
        assertTrue(registry.isEmergencyOpen(pid), "after open");

        vm.prank(owner);
        governor.cancelEmergencySettle(pid);
        assertFalse(registry.isEmergencyOpen(pid), "after cancel");

        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());
        assertTrue(registry.isEmergencyOpen(pid), "after re-open");

        // Finalize (no blocks → not blocked → settles).
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        vm.prank(owner);
        governor.finalizeEmergencySettle(pid);
        assertFalse(registry.isEmergencyOpen(pid), "after finalize");
    }

    /// @notice Open emergency, cancel, verify state cleared, re-open with
    ///         different calls, finalize successfully — proves registry clears
    ///         stored calls on cancel and accepts new ones.
    function test_registryClearsCallsOnCancel() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());
        assertFalse(!registry.isEmergencyOpen(pid));

        vm.prank(owner);
        governor.cancelEmergencySettle(pid);
        assertFalse(registry.isEmergencyOpen(pid), "closed after cancel");

        // Re-open with different calls.
        BatchExecutorLib.Call[] memory newCalls = new BatchExecutorLib.Call[](1);
        newCalls[0] = BatchExecutorLib.Call({
            target: address(usdc), data: abi.encodeCall(usdc.approve, (address(targetToken), 42)), value: 0
        });
        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, newCalls);
        assertTrue(registry.isEmergencyOpen(pid), "open after re-open");

        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        vm.prank(owner);
        governor.finalizeEmergencySettle(pid);
        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Settled));
    }

    /// @notice MS-H2: standard settle races ahead of emergency review — verify
    ///         `isEmergencyOpen` stays true after settle (registry not cancelled).
    ///         The review must be resolved via `resolveEmergencyReview` after
    ///         reviewEnd; `finalizeEmergencySettle` would revert because the
    ///         proposal is already Settled.
    function test_standardSettleDoesNotCancelEmergencyViaRegistry() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());
        assertTrue(registry.isEmergencyOpen(pid));

        governor.settleProposal(pid);
        assertEq(uint256(governor.getProposal(pid).state), uint256(ISyndicateGovernor.ProposalState.Settled));
        assertTrue(registry.isEmergencyOpen(pid), "emergency stays open after standard settle");

        // Review resolves naturally at reviewEnd via permissionless call.
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        registry.resolveEmergencyReview(pid);
        assertFalse(registry.isEmergencyOpen(pid), "closed after permissionless resolve");
    }

    /// @notice Open emergency with no blocks, finalize — calls returned from
    ///         registry are executed and proposal settles.
    function test_registryStoresAndReturnsCalls() public {
        uint256 pid = _createExecutedProposal(7 days);
        vm.warp(vm.getBlockTimestamp() + 7 days);

        vm.prank(owner);
        governor.emergencySettleWithCalls(pid, _customCalls());

        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        vm.prank(owner);
        governor.finalizeEmergencySettle(pid);

        assertEq(
            uint256(governor.getProposal(pid).state),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "proposal settled via registry-returned calls"
        );
        assertFalse(vault.redemptionsLocked());
    }
}
