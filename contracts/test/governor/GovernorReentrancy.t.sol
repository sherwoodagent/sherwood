// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {ISyndicateVault} from "../../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockAgentRegistry} from "../mocks/MockAgentRegistry.sol";

/// @title GovernorReentrancy.t
/// @notice Regression for G-C6 — `vote` / `cancelProposal` / `vetoProposal` /
///         `emergencyCancel` MUST carry `nonReentrant`. The governor calls
///         into the guardian registry during `_resolveState` when the review
///         window has elapsed; a hostile registry (future swap, WOOD upgrade,
///         or compromised implementation) could otherwise re-enter the
///         governor via `resolveReview`.
///
///         Strategy: wire the governor to an attacker-controlled registry
///         implementing `IGuardianRegistry.resolveReview`. The attacker tries
///         to re-enter one of the four guarded externals. The `Reentrancy()`
///         guard must trigger; the external call bubbles the revert.
contract GovernorReentrancyTest is Test {
    SyndicateGovernor public governor;
    SyndicateVault public vault;
    ReentrantRegistry public registry;
    BatchExecutorLib public executorLib;
    ERC20Mock public usdc;
    ERC20Mock public targetToken;
    MockAgentRegistry public agentRegistry;

    address public owner = makeAddr("owner");
    address public agent = makeAddr("agent");
    address public lp1 = makeAddr("lp1");
    address public lp2 = makeAddr("lp2");

    uint256 public agentNftId;

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant COOLDOWN_PERIOD = 1 days;
    uint256 constant REVIEW_PERIOD = 1 hours;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        targetToken = new ERC20Mock("Target", "TGT", 18);
        executorLib = new BatchExecutorLib();
        agentRegistry = new MockAgentRegistry();
        registry = new ReentrantRegistry();
        registry.setReviewPeriod(REVIEW_PERIOD);
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
                    maxStrategyDuration: 30 days,
                    protocolFeeBps: 0,
                    protocolFeeRecipient: address(0),
                    guardianFeeBps: 0
                }),
                address(registry)
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));
        registry.setGovernor(address(governor));

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
        vm.warp(vm.getBlockTimestamp() + 1);
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

    function _propose() internal returns (uint256 pid) {
        vm.prank(agent);
        pid = governor.propose(
            address(vault), "ipfs://reentry", 1000, 7 days, _execCalls(), _settleCalls(), _emptyCoProposers()
        );
        vm.warp(vm.getBlockTimestamp() + 1);
    }

    // ── Tests ──

    /// @notice `vote` carries `nonReentrant` — a reentry during registry
    ///         callout should revert with `Reentrancy()`.
    /// @dev The attack surface: `vote` -> `_resolveState` -> `resolveReview`.
    ///      But `_resolveState` in `vote` only reaches `resolveReview` when
    ///      the proposal is in `GuardianReview` with review window elapsed —
    ///      at that point `vote` reverts `NotWithinVotingPeriod`, so the
    ///      outer guarded fn can't set up the re-entry via `resolveReview`.
    ///      Instead we validate the guard by having the attacker re-enter
    ///      directly from a separate reentry entrypoint; see
    ///      `test_cancelProposal_revertsOnReentry` for the concrete driver.
    ///      Here we assert the modifier is present by triggering the same
    ///      guard via the outer state flow used by `cancelProposal`.
    function test_vote_hasNonReentrantGuard() public {
        uint256 pid = _propose();
        // Prime the attacker to re-enter `vote(pid, For)`.
        registry.arm(address(governor), abi.encodeCall(ISyndicateGovernor.vote, (pid, ISyndicateGovernor.VoteType.For)));
        // vote() itself doesn't call into the registry during Pending, so we
        // drive the guard via `cancelProposal` after moving past the vote
        // window (which then calls `_resolveState` into `resolveReview`).
        // This confirms the shared `_reentrancyStatus` latch works.
        _voteFor(pid);
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReviewFlag(true);
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);
        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.Reentrancy.selector);
        governor.cancelProposal(pid);
    }

    function test_cancelProposal_revertsOnReentry() public {
        uint256 pid = _propose();
        _voteFor(pid);
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReviewFlag(true);
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        // Re-enter `cancelProposal(pid)` from within `resolveReview`.
        registry.arm(address(governor), abi.encodeCall(ISyndicateGovernor.cancelProposal, (pid)));

        vm.prank(agent);
        vm.expectRevert(ISyndicateGovernor.Reentrancy.selector);
        governor.cancelProposal(pid);
    }

    function test_vetoProposal_revertsOnReentry() public {
        uint256 pid = _propose();
        _voteFor(pid);
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReviewFlag(true);
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        // Attacker re-enters `vetoProposal` from within `resolveReview`.
        registry.arm(address(governor), abi.encodeCall(ISyndicateGovernor.vetoProposal, (pid)));

        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.Reentrancy.selector);
        governor.vetoProposal(pid);
    }

    function test_emergencyCancel_revertsOnReentry() public {
        uint256 pid = _propose();
        _voteFor(pid);
        vm.warp(vm.getBlockTimestamp() + VOTING_PERIOD + 1);
        registry.openReviewFlag(true);
        vm.warp(vm.getBlockTimestamp() + REVIEW_PERIOD + 1);

        // Attacker re-enters `emergencyCancel` from within `resolveReview`.
        registry.arm(address(governor), abi.encodeCall(ISyndicateGovernor.emergencyCancel, (pid)));

        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.Reentrancy.selector);
        governor.emergencyCancel(pid);
    }

    function _voteFor(uint256 pid) internal {
        vm.prank(lp1);
        governor.vote(pid, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(pid, ISyndicateGovernor.VoteType.For);
    }
}

/// @notice Hostile mock registry. `resolveReview` attempts a re-entry into the
///         governor via an armed callback, proving the `nonReentrant` guard
///         wraps the outer entrypoint.
contract ReentrantRegistry {
    uint256 public reviewPeriod;
    address public governor;

    address public reentryTarget;
    bytes public reentryData;
    bool public reviewOpened;

    function setReviewPeriod(uint256 r) external {
        reviewPeriod = r;
    }

    function setGovernor(address g) external {
        governor = g;
    }

    function arm(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryData = data;
    }

    /// @dev Flip this to signal the proposal should resolve via getReviewState
    ///      path (returns `resolved=false` so `_resolveState` falls into
    ///      `resolveReview`).
    function openReviewFlag(bool) external {
        reviewOpened = true;
    }

    function resolveReview(uint256) external returns (bool blocked) {
        if (reentryTarget != address(0)) {
            // Best-effort re-entry. Bubble up the revert so the outer test can
            // match on `Reentrancy()`.
            (bool ok, bytes memory ret) = reentryTarget.call(reentryData);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
        return false;
    }

    function getReviewState(uint256)
        external
        view
        returns (bool opened, bool resolved, bool blocked, bool cohortTooSmall)
    {
        // Force _resolveAfterVote's mutating path to call `resolveReview` by
        // returning resolved=false once the review window has elapsed.
        if (reviewOpened) return (true, false, false, false);
        // Default: resolved so the state machine skips the mutating callout.
        return (true, true, false, false);
    }
}
