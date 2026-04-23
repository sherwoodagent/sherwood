// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {GuardianRegistry} from "../src/GuardianRegistry.sol";
import {IGuardianRegistry} from "../src/interfaces/IGuardianRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @title GuardianRegistryDelegation — V1.5 Phase 2 tests
/// @notice Covers delegateStake / unstake lifecycle + checkpoint attribution
///         + vote-weight integration via getPastVoteWeight.
contract GuardianRegistryDelegationTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;

    address owner = makeAddr("owner");
    address governor = makeAddr("governor");
    address factory = makeAddr("factory");
    address delegate_ = makeAddr("delegate");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant COOL_DOWN = 7 days;

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, COOL_DOWN, 24 hours, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        // Fund + approve delegators.
        wood.mint(alice, 100_000e18);
        wood.mint(bob, 100_000e18);
        vm.prank(alice);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(bob);
        wood.approve(address(registry), type(uint256).max);

        // I-5: delegateStake now rejects an inactive delegate. Stake the
        // delegate above min so every test below can delegate to them.
        wood.mint(delegate_, 20_000e18);
        vm.prank(delegate_);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(delegate_);
        registry.stakeAsGuardian(20_000e18, 99);
    }

    // ── delegateStake ──

    function test_delegateStake_increasesInboundAndTotal() public {
        uint256 balBefore = wood.balanceOf(address(registry)); // delegate_'s own stake
        vm.prank(alice);
        registry.delegateStake(delegate_, 50e18);

        assertEq(registry.delegationOf(alice, delegate_), 50e18);
        assertEq(registry.delegatedInbound(delegate_), 50e18);
        assertEq(registry.totalDelegatedStake(), 50e18);
        assertEq(wood.balanceOf(address(registry)), balBefore + 50e18);
    }

    function test_delegateStake_multipleFromSameDelegatorAccumulate() public {
        vm.prank(alice);
        registry.delegateStake(delegate_, 30e18);
        vm.prank(alice);
        registry.delegateStake(delegate_, 20e18);

        assertEq(registry.delegationOf(alice, delegate_), 50e18);
        assertEq(registry.delegatedInbound(delegate_), 50e18);
    }

    function test_delegateStake_multipleDelegatorsSumIntoInbound() public {
        vm.prank(alice);
        registry.delegateStake(delegate_, 30e18);
        vm.prank(bob);
        registry.delegateStake(delegate_, 70e18);

        assertEq(registry.delegationOf(alice, delegate_), 30e18);
        assertEq(registry.delegationOf(bob, delegate_), 70e18);
        assertEq(registry.delegatedInbound(delegate_), 100e18);
        assertEq(registry.totalDelegatedStake(), 100e18);
    }

    function test_delegateStake_selfDelegationReverts() public {
        vm.expectRevert(IGuardianRegistry.CannotSelfDelegate.selector);
        vm.prank(alice);
        registry.delegateStake(alice, 50e18);
    }

    function test_delegateStake_zeroAmountReverts() public {
        vm.expectRevert(IGuardianRegistry.AmountZero.selector);
        vm.prank(alice);
        registry.delegateStake(delegate_, 0);
    }

    function test_delegateStake_zeroAddressReverts() public {
        vm.expectRevert(IGuardianRegistry.InvalidDelegate.selector);
        vm.prank(alice);
        registry.delegateStake(address(0), 10e18);
    }

    /// @notice I-5: delegating to an address that isn't an active guardian
    ///         traps the delegator's WOOD behind a 7d cooldown pointing at a
    ///         vote-inert address. Reject early.
    function test_delegateStake_inactiveDelegateReverts() public {
        address noStaker = makeAddr("noStaker");
        vm.expectRevert(IGuardianRegistry.InactiveDelegate.selector);
        vm.prank(alice);
        registry.delegateStake(noStaker, 10e18);
    }

    /// @notice I-5: a delegate who has requested unstake (still has stake but
    ///         is not active) also rejects delegation.
    function test_delegateStake_delegateMidUnstakeReverts() public {
        vm.prank(delegate_);
        registry.requestUnstakeGuardian();

        vm.expectRevert(IGuardianRegistry.InactiveDelegate.selector);
        vm.prank(alice);
        registry.delegateStake(delegate_, 50e18);
    }

    // ── unstake lifecycle ──

    function test_unstakeDelegation_fullFlow() public {
        vm.prank(alice);
        registry.delegateStake(delegate_, 50e18);

        uint256 balBefore = wood.balanceOf(alice);
        vm.prank(alice);
        registry.requestUnstakeDelegation(delegate_);
        // Before cooldown — claim reverts
        vm.expectRevert(IGuardianRegistry.UnstakeCooldownActive.selector);
        vm.prank(alice);
        registry.claimUnstakeDelegation(delegate_);

        vm.warp(vm.getBlockTimestamp() + COOL_DOWN + 1);

        vm.prank(alice);
        registry.claimUnstakeDelegation(delegate_);

        assertEq(wood.balanceOf(alice), balBefore + 50e18);
        assertEq(registry.delegationOf(alice, delegate_), 0);
        assertEq(registry.delegatedInbound(delegate_), 0);
        assertEq(registry.totalDelegatedStake(), 0);
    }

    function test_cancelUnstakeDelegation_restoresState() public {
        vm.prank(alice);
        registry.delegateStake(delegate_, 50e18);

        vm.prank(alice);
        registry.requestUnstakeDelegation(delegate_);

        vm.prank(alice);
        registry.cancelUnstakeDelegation(delegate_);

        // After cancel, another request should succeed (cooldown window reset)
        vm.prank(alice);
        registry.requestUnstakeDelegation(delegate_);
    }

    function test_requestUnstakeDelegation_noActiveReverts() public {
        vm.expectRevert(IGuardianRegistry.NoActiveDelegation.selector);
        vm.prank(alice);
        registry.requestUnstakeDelegation(delegate_);
    }

    function test_delegateStake_afterUnstakeRequest_implicitlyCancels() public {
        vm.prank(alice);
        registry.delegateStake(delegate_, 50e18);
        vm.prank(alice);
        registry.requestUnstakeDelegation(delegate_);

        // Re-delegating clears the in-flight unstake request.
        vm.prank(alice);
        registry.delegateStake(delegate_, 20e18);

        // Prove the unstake was cancelled: can request again now.
        vm.prank(alice);
        registry.requestUnstakeDelegation(delegate_);
        assertEq(registry.delegationOf(alice, delegate_), 70e18);
    }

    // ── historical views ──

    function test_getPastDelegationTo_checkpointsByTimestamp() public {
        vm.prank(alice);
        registry.delegateStake(delegate_, 30e18);
        uint256 t1 = vm.getBlockTimestamp();

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(alice);
        registry.delegateStake(delegate_, 20e18);
        uint256 t2 = vm.getBlockTimestamp();

        vm.warp(vm.getBlockTimestamp() + 1);

        assertEq(registry.getPastDelegationTo(alice, delegate_, t1), 30e18);
        assertEq(registry.getPastDelegationTo(alice, delegate_, t2), 50e18);
    }

    function test_getPastDelegated_tracksInbound() public {
        vm.prank(alice);
        registry.delegateStake(delegate_, 30e18);
        uint256 t1 = vm.getBlockTimestamp();

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(bob);
        registry.delegateStake(delegate_, 70e18);
        uint256 t2 = vm.getBlockTimestamp();

        vm.warp(vm.getBlockTimestamp() + 1);

        assertEq(registry.getPastDelegated(delegate_, t1), 30e18);
        assertEq(registry.getPastDelegated(delegate_, t2), 100e18);
    }

    function test_getPastVoteWeight_combinesOwnAndDelegated() public {
        // setUp stakes delegate_ with 20_000e18 own stake. Alice delegates 5k on top.
        vm.prank(alice);
        registry.delegateStake(delegate_, 5_000e18);

        uint256 t1 = vm.getBlockTimestamp();
        vm.warp(vm.getBlockTimestamp() + 1);

        assertEq(registry.getPastVoteWeight(delegate_, t1), 25_000e18, "own 20k + delegated 5k");
    }

    function test_getPastTotalDelegated_tracksGlobal() public {
        vm.prank(alice);
        registry.delegateStake(delegate_, 30e18);
        uint256 t1 = vm.getBlockTimestamp();

        vm.warp(vm.getBlockTimestamp() + 1);
        assertEq(registry.getPastTotalDelegated(t1), 30e18);
    }
}
