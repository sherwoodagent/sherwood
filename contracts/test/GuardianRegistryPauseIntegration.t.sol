// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";

import {GuardianRegistry} from "../src/GuardianRegistry.sol";
import {IGuardianRegistry} from "../src/interfaces/IGuardianRegistry.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockGovernorMinimal} from "./mocks/MockGovernorMinimal.sol";

/// @title GuardianRegistryPauseIntegration.t
/// @notice Task 27.C — cross-cutting pause behavior: deadman unpause after
///         7 days is open to anyone; review voting is frozen while
///         stake/unstake/claim-unstake paths remain open (exit stays
///         unobstructed during an incident).
contract GuardianRegistryPauseIntegrationTest is Test {
    GuardianRegistry public registry;
    ERC20Mock public wood;
    MockGovernorMinimal public governor;

    address public owner = makeAddr("owner");
    address public factory = makeAddr("factory");
    address public guardian = makeAddr("guardian");
    address public stranger = makeAddr("stranger");

    uint256 constant MIN_GUARDIAN_STAKE = 10_000e18;
    uint256 constant MIN_OWNER_STAKE = 10_000e18;
    uint256 constant COOL_DOWN = 7 days;
    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant BLOCK_QUORUM_BPS = 3000;
    uint256 constant PROPOSAL_ID = 42;

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        governor = new MockGovernorMinimal();

        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (
                owner,
                address(governor),
                factory,
                address(wood),
                MIN_GUARDIAN_STAKE,
                MIN_OWNER_STAKE,
                COOL_DOWN,
                REVIEW_PERIOD,
                BLOCK_QUORUM_BPS
            )
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        wood.mint(guardian, 100_000e18);
        vm.prank(guardian);
        wood.approve(address(registry), type(uint256).max);
    }

    // ──────────────────────────────────────────────────────────────
    // Deadman unpause — anyone can unpause after DEADMAN_UNPAUSE_DELAY
    // ──────────────────────────────────────────────────────────────

    /// @notice Full flow: owner pauses, 7 days + 1 second elapses, any EOA
    ///         unpauses permissionlessly. Emits `Unpaused(_, deadman=true)`.
    function test_pause_deadman_7days_thenAnyoneUnpauses() public {
        vm.prank(owner);
        registry.pause();
        assertTrue(registry.paused(), "registry paused");
        uint256 pausedAt = registry.pausedAt();
        assertGt(pausedAt, 0, "pausedAt stamped");

        // 7 days + 1 second elapsed — deadman window open.
        vm.warp(pausedAt + registry.DEADMAN_UNPAUSE_DELAY() + 1);

        vm.expectEmit(true, false, false, true, address(registry));
        emit IGuardianRegistry.Unpaused(stranger, true);
        vm.prank(stranger);
        registry.unpause();

        assertFalse(registry.paused(), "paused cleared after deadman unpause");
        assertEq(registry.pausedAt(), 0, "pausedAt reset");
    }

    /// @notice Negative control: 1 second before the deadman window elapses,
    ///         a random EOA unpause still reverts.
    function test_pause_deadman_6days23h59m59s_strangerReverts() public {
        vm.prank(owner);
        registry.pause();

        vm.warp(block.timestamp + registry.DEADMAN_UNPAUSE_DELAY() - 1);

        vm.prank(stranger);
        vm.expectRevert(IGuardianRegistry.NotPausedOrDeadmanNotElapsed.selector);
        registry.unpause();
    }

    // ──────────────────────────────────────────────────────────────
    // Pause freezes review voting but NOT stake / unstake paths
    // ──────────────────────────────────────────────────────────────

    /// @notice While paused, `voteOnProposal` reverts with `ProtocolPaused`,
    ///         but `stakeAsGuardian`, `requestUnstakeGuardian`, and
    ///         `claimUnstakeGuardian` all succeed. Exit paths stay open so
    ///         guardians can manage positions during an incident.
    function test_pause_freezesVoteOnProposal_butNotStakeOrUnstake() public {
        // Pre-pause: open a review so voteOnProposal can be exercised.
        uint256 voteEnd = block.timestamp;
        uint256 reviewEnd = voteEnd + REVIEW_PERIOD;
        governor.setProposal(PROPOSAL_ID, voteEnd, reviewEnd);

        // Stake BEFORE pause so the guardian is active for the vote attempt.
        vm.prank(guardian);
        registry.stakeAsGuardian(MIN_GUARDIAN_STAKE, 1);

        // Stake more guardians so the registry has enough total stake for
        // openReview to not auto-flag cohortTooSmall. We'll do this via the
        // single existing guardian's top-up (same account).
        vm.prank(guardian);
        registry.stakeAsGuardian(40_000e18, 0);

        registry.openReview(PROPOSAL_ID);

        // Pause.
        vm.prank(owner);
        registry.pause();
        assertTrue(registry.paused());

        // voteOnProposal frozen.
        vm.prank(guardian);
        vm.expectRevert(IGuardianRegistry.ProtocolPaused.selector);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);

        // A new guardian can still stake during pause (exit/management must
        // stay open).
        address guardian2 = makeAddr("guardian2");
        wood.mint(guardian2, 100_000e18);
        vm.prank(guardian2);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(guardian2);
        registry.stakeAsGuardian(MIN_GUARDIAN_STAKE, 2);
        assertEq(registry.guardianStake(guardian2), MIN_GUARDIAN_STAKE, "stake succeeds while paused");

        // requestUnstake works while paused.
        vm.prank(guardian);
        registry.requestUnstakeGuardian();
        assertFalse(registry.isActiveGuardian(guardian), "unstake request clears active flag");

        // Cooldown elapses, claimUnstake still succeeds while paused.
        vm.warp(block.timestamp + COOL_DOWN + 1);
        uint256 balBefore = wood.balanceOf(guardian);
        vm.prank(guardian);
        registry.claimUnstakeGuardian();
        assertGt(wood.balanceOf(guardian) - balBefore, 0, "claimUnstake returns WOOD while paused");
        assertEq(registry.guardianStake(guardian), 0, "stake cleared post-claim");
    }
}
