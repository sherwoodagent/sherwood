// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";

import {SyndicateGovernor} from "../../../src/SyndicateGovernor.sol";
import {SyndicateFactory} from "../../../src/SyndicateFactory.sol";
import {GuardianRegistry} from "../../../src/GuardianRegistry.sol";
import {IGuardianRegistry} from "../../../src/interfaces/IGuardianRegistry.sol";
import {ISyndicateGovernor} from "../../../src/interfaces/ISyndicateGovernor.sol";
import {GovernorParameters} from "../../../src/GovernorParameters.sol";

import {ERC20Mock} from "../../mocks/ERC20Mock.sol";

/// @title ProtocolHandler
/// @notice Bounded fuzz-action surface for the protocol invariant harness
///         (INV-2 / INV-3 / INV-30 / INV-33 / INV-46). Drives the governance
///         and registry surfaces that the 5 target invariants observe:
///
///         - Governor parameter-change lifecycle (queue / finalize / cancel) —
///           exercises INV-30 (`protocolFeeBps > 0 ⇒ recipient != 0`).
///         - Guardian registry pause / unpause + guarded writes — exercises
///           INV-46 (pause semantics across every guardian-facing external).
///         - Guardian stake / unstake lifecycle — keeps the actor space non-
///           trivial so pause-fuzzing hits live cohort state.
///         - Time warps — keeps the timelock finalize path reachable within
///           the default fuzz run budget.
///
///         The handler intentionally does NOT drive the full proposal lifecycle
///         (propose → vote → execute → settle). Doing so would require ERC20
///         votes + a live SyndicateVault proxy; the invariants that care about
///         the proposal surface (INV-2, INV-3) are still asserted via the real
///         governor's public views — they hold vacuously under this handler
///         and guard against structural drift if the governor ever mutates
///         `_activeProposal` outside `executeProposal` / `_finishSettlement`
///         (the G-C2/C3 regression vector from issue #225).
///
///         Actor set: 5 shareholders, 3 agents, 10 guardians, 1 owner.
contract ProtocolHandler is Test {
    SyndicateGovernor public governor;
    SyndicateFactory public factory;
    GuardianRegistry public registry;
    ERC20Mock public wood;

    address public governorOwner;
    address public factoryOwner;
    address public registryOwner;

    // Actor pools (spec calls for 5 shareholders / 3 agents / 10 guardians / 1 owner;
    // we materialize the sets the handler's actions actually use).
    address[] public shareholders; // length 5
    address[] public agents; // length 3
    address[] public guardians; // length 10

    // INV-46 revert-matrix bookkeeping — set when a pause-guarded call is made
    // during pause; the invariant contract reads these to verify the required
    // revert actually happened (all guarded writes MUST revert when paused).
    uint256 public pausedCallAttempts;
    uint256 public pausedCallReverts;

    // Pending-change seen counters — debug aids; wired up as public views the
    // invariant contract can print via `targetContract` summary.
    // V1.5: `finalizeSuccesses` removed — governor setters apply immediately.
    uint256 public queueSuccesses;

    constructor(
        SyndicateGovernor _governor,
        SyndicateFactory _factory,
        GuardianRegistry _registry,
        ERC20Mock _wood,
        address _governorOwner,
        address _factoryOwner,
        address _registryOwner
    ) {
        governor = _governor;
        factory = _factory;
        registry = _registry;
        wood = _wood;
        governorOwner = _governorOwner;
        factoryOwner = _factoryOwner;
        registryOwner = _registryOwner;

        for (uint256 i = 0; i < 5; i++) {
            shareholders.push(makeAddr(string(abi.encodePacked("shareholder", vm.toString(i)))));
        }
        for (uint256 i = 0; i < 3; i++) {
            agents.push(makeAddr(string(abi.encodePacked("agent", vm.toString(i)))));
        }
        for (uint256 i = 0; i < 10; i++) {
            address g = makeAddr(string(abi.encodePacked("guardian", vm.toString(i))));
            guardians.push(g);
            wood.mint(g, 1_000_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Governor parameter lifecycle — drives INV-30
    // ──────────────────────────────────────────────────────────────

    /// @dev Queue a new `protocolFeeBps` change. The setter's own guard
    ///      refuses to queue a non-zero bps value while recipient == 0 —
    ///      so INV-30 cannot be violated through the queue edge.
    function queueProtocolFeeBps(uint256 bpsSeed) external {
        uint256 bps = bound(bpsSeed, 0, 1_000); // governor MAX_PROTOCOL_FEE_BPS = 1000
        vm.prank(governorOwner);
        try governor.setProtocolFeeBps(bps) {
            queueSuccesses += 1;
        } catch {}
    }

    /// @dev Queue a new protocol-fee recipient change. Zero-address is rejected
    ///      by the setter so the queued newValue is always nonzero.
    function queueProtocolFeeRecipient(uint256 recipientSeed) external {
        // Pick from a non-zero address pool so the setter accepts the call.
        address[3] memory pool = [makeAddr("feeRecipient1"), makeAddr("feeRecipient2"), makeAddr("feeRecipient3")];
        address r = pool[bound(recipientSeed, 0, 2)];
        vm.prank(governorOwner);
        try governor.setProtocolFeeRecipient(r) {
            queueSuccesses += 1;
        } catch {}
    }

    // V1.5: finalizeParameterChange / cancelParameterChange removed from governor.
    // Setters apply immediately; invariant surfaces now only include queue-style
    // entrypoints that directly mutate state on the governor.

    // ──────────────────────────────────────────────────────────────
    // Registry pause surface — drives INV-46
    // ──────────────────────────────────────────────────────────────

    function pauseRegistry() external {
        vm.prank(registryOwner);
        try registry.pause() {} catch {}
    }

    function unpauseRegistry() external {
        vm.prank(registryOwner);
        try registry.unpause() {} catch {}
    }

    /// @dev Attempt `flushBurn` — is guarded by `whenNotPaused`. Tracks the
    ///      attempt / revert counters so the invariant can cross-check pause
    ///      semantics: every attempt during pause MUST revert.
    function tryFlushBurn() external {
        bool isPaused = registry.paused();
        if (isPaused) pausedCallAttempts += 1;
        try registry.flushBurn() {
        // Succeeded — if paused, this is a BUG (invariant will catch it).
        }
        catch {
            if (isPaused) pausedCallReverts += 1;
        }
    }

    // V1.5: claimEpochReward + recordEpochBudget removed from on-chain surface.
    // WOOD epoch rewards live entirely in Merkl post-ToB review.

    /// @dev Attempt `voteOnProposal` with pause semantics tracking. Uses a
    ///      proposalId of 1 which has no review opened — the call will revert
    ///      on the pause check FIRST (modifier runs before the `!r.opened`
    ///      check). Track attempt / revert counters.
    function tryVoteOnProposal(uint256 actorSeed, uint256 supportSeed) external {
        address g = guardians[bound(actorSeed, 0, guardians.length - 1)];
        IGuardianRegistry.GuardianVoteType s = (supportSeed % 2 == 0)
            ? IGuardianRegistry.GuardianVoteType.Approve
            : IGuardianRegistry.GuardianVoteType.Block;
        bool isPaused = registry.paused();
        if (isPaused) pausedCallAttempts += 1;
        vm.prank(g);
        try registry.voteOnProposal(1, s) {}
        catch {
            if (isPaused) pausedCallReverts += 1;
        }
    }

    /// @dev Attempt `openReview`. Guarded by `whenNotPaused`. Since no
    ///      proposal exists at id 1 in this harness, the call will always
    ///      revert; during pause the revert must come from the pause modifier.
    function tryOpenReview(uint256 proposalSeed) external {
        uint256 pid = bound(proposalSeed, 1, 3);
        bool isPaused = registry.paused();
        if (isPaused) pausedCallAttempts += 1;
        try registry.openReview(pid) {}
        catch {
            if (isPaused) pausedCallReverts += 1;
        }
    }

    /// @dev Attempt `resolveReview`. Same semantics — guarded by
    ///      `whenNotPaused`. During pause, must revert.
    function tryResolveReview(uint256 proposalSeed) external {
        uint256 pid = bound(proposalSeed, 1, 3);
        bool isPaused = registry.paused();
        if (isPaused) pausedCallAttempts += 1;
        try registry.resolveReview(pid) {}
        catch {
            if (isPaused) pausedCallReverts += 1;
        }
    }

    /// @dev Attempt `resolveEmergencyReview`. Guarded by `whenNotPaused`.
    function tryResolveEmergencyReview(uint256 proposalSeed) external {
        uint256 pid = bound(proposalSeed, 1, 3);
        bool isPaused = registry.paused();
        if (isPaused) pausedCallAttempts += 1;
        try registry.resolveEmergencyReview(pid) {}
        catch {
            if (isPaused) pausedCallReverts += 1;
        }
    }

    // ──────────────────────────────────────────────────────────────
    // Stake / unstake — callable during pause per spec §3.1
    // ──────────────────────────────────────────────────────────────

    /// @dev Stake action: MUST succeed during pause (admin ops stay live).
    ///      The invariant doesn't track this one — it's here to keep the
    ///      guardian cohort non-empty across fuzzing.
    function stake(uint256 actorSeed, uint256 amountSeed) external {
        address g = guardians[bound(actorSeed, 0, guardians.length - 1)];
        uint256 amount = bound(amountSeed, registry.minGuardianStake(), 100_000e18);
        vm.prank(g);
        try registry.stakeAsGuardian(amount, 1) {} catch {}
    }

    function requestUnstake(uint256 actorSeed) external {
        address g = guardians[bound(actorSeed, 0, guardians.length - 1)];
        vm.prank(g);
        try registry.requestUnstakeGuardian() {} catch {}
    }

    function cancelUnstake(uint256 actorSeed) external {
        address g = guardians[bound(actorSeed, 0, guardians.length - 1)];
        vm.prank(g);
        try registry.cancelUnstakeGuardian() {} catch {}
    }

    function claimUnstake(uint256 actorSeed) external {
        address g = guardians[bound(actorSeed, 0, guardians.length - 1)];
        vm.prank(g);
        try registry.claimUnstakeGuardian() {} catch {}
    }

    // ──────────────────────────────────────────────────────────────
    // Time
    // ──────────────────────────────────────────────────────────────

    function warp(uint256 delta) external {
        delta = bound(delta, 1 hours, 3 days);
        vm.warp(block.timestamp + delta);
    }

    // ──────────────────────────────────────────────────────────────
    // Views
    // ──────────────────────────────────────────────────────────────

    function getGuardians() external view returns (address[] memory) {
        return guardians;
    }

    function getShareholders() external view returns (address[] memory) {
        return shareholders;
    }

    function getAgents() external view returns (address[] memory) {
        return agents;
    }
}
