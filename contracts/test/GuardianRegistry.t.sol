// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {GuardianRegistry} from "../src/GuardianRegistry.sol";
import {IGuardianRegistry} from "../src/interfaces/IGuardianRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract GuardianRegistryInitTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    address owner = address(0xA11CE);
    address governor = address(0x9000);
    address factory = address(0xFAC10);

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, 0, 7 days, 24 hours, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));
    }

    function test_initialize_setsFields() public {
        assertEq(registry.owner(), owner);
        assertEq(registry.governor(), governor);
        assertEq(registry.factory(), factory);
        assertEq(address(registry.wood()), address(wood));
        assertEq(registry.minGuardianStake(), 10_000e18);
        assertEq(registry.reviewPeriod(), 24 hours);
        assertEq(registry.blockQuorumBps(), 3000);
        assertFalse(registry.paused());
        assertGt(registry.epochGenesis(), 0);
    }

    function test_initialize_revertsOnZeroGovernor() public {
        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, address(0), factory, address(wood), 10_000e18, 10_000e18, 0, 7 days, 24 hours, 3000)
        );
        vm.expectRevert(IGuardianRegistry.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }
}

contract GuardianRegistryStakeTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    address owner = address(0xA11CE);
    address governor = address(0x9000);
    address factory = address(0xFAC10);
    address alice = address(0xA11CE5);

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, 0, 7 days, 24 hours, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        wood.mint(alice, 100_000e18);
        vm.prank(alice);
        wood.approve(address(registry), type(uint256).max);
    }

    function test_stakeAsGuardian_firstStake_setsAllFields() public {
        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.GuardianStaked(alice, 10_000e18, 42);
        vm.prank(alice);
        registry.stakeAsGuardian(10_000e18, 42);

        assertEq(registry.guardianStake(alice), 10_000e18);
        assertEq(registry.totalGuardianStake(), 10_000e18);
        assertTrue(registry.isActiveGuardian(alice));
        assertEq(registry.activeGuardianCount(), 1);
    }

    function test_stakeAsGuardian_topUp_accumulates_ignoresAgentIdChange() public {
        vm.prank(alice);
        registry.stakeAsGuardian(10_000e18, 42);
        vm.prank(alice);
        registry.stakeAsGuardian(5_000e18, 99); // different agentId should be ignored
        assertEq(registry.guardianStake(alice), 15_000e18);
        assertEq(registry.totalGuardianStake(), 15_000e18);
        assertEq(registry.activeGuardianCount(), 1); // still one guardian
        // TODO: if an agentId view is added, assert it's still 42
    }

    function test_stakeAsGuardian_revertsIfBelowMinOnFirstStake() public {
        vm.prank(alice);
        vm.expectRevert(IGuardianRegistry.InsufficientStake.selector);
        registry.stakeAsGuardian(1, 42);
    }

    function test_stakeAsGuardian_revertsIfPaused() public {
        vm.skip(true); // TODO(task-22): re-enable after pause() is implemented
        vm.prank(owner);
        registry.pause();
        vm.prank(alice);
        vm.expectRevert(IGuardianRegistry.ProtocolPaused.selector);
        registry.stakeAsGuardian(10_000e18, 42);
    }

    function test_stakeAsGuardian_transfersWoodFromCaller() public {
        uint256 balBefore = wood.balanceOf(alice);
        vm.prank(alice);
        registry.stakeAsGuardian(10_000e18, 42);
        assertEq(wood.balanceOf(alice), balBefore - 10_000e18);
        assertEq(wood.balanceOf(address(registry)), 10_000e18);
    }
}

contract GuardianRegistryUnstakeTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    address owner = address(0xA11CE);
    address governor = address(0x9000);
    address factory = address(0xFAC10);
    address alice = address(0xA11CE5);

    uint256 constant COOL_DOWN = 7 days;

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, 0, COOL_DOWN, 24 hours, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        wood.mint(alice, 100_000e18);
        vm.prank(alice);
        wood.approve(address(registry), type(uint256).max);

        vm.prank(alice);
        registry.stakeAsGuardian(10_000e18, 42);
    }

    function test_requestUnstake_removesVotingPower() public {
        assertTrue(registry.isActiveGuardian(alice));
        assertEq(registry.totalGuardianStake(), 10_000e18);
        assertEq(registry.activeGuardianCount(), 1);

        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.GuardianUnstakeRequested(alice, block.timestamp);
        vm.prank(alice);
        registry.requestUnstakeGuardian();

        assertFalse(registry.isActiveGuardian(alice));
        assertEq(registry.totalGuardianStake(), 0);
        assertEq(registry.activeGuardianCount(), 0);
        // stake itself not yet transferred out
        assertEq(registry.guardianStake(alice), 10_000e18);
    }

    function test_requestUnstake_revertsIfNotStaked() public {
        address bob = address(0xB0B);
        vm.prank(bob);
        vm.expectRevert(IGuardianRegistry.NoActiveStake.selector);
        registry.requestUnstakeGuardian();
    }

    function test_requestUnstake_revertsIfAlreadyRequested() public {
        vm.prank(alice);
        registry.requestUnstakeGuardian();
        vm.prank(alice);
        vm.expectRevert(IGuardianRegistry.UnstakeAlreadyRequested.selector);
        registry.requestUnstakeGuardian();
    }

    function test_cancelUnstake_restoresVotingPower() public {
        vm.prank(alice);
        registry.requestUnstakeGuardian();
        assertFalse(registry.isActiveGuardian(alice));

        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.GuardianUnstakeCancelled(alice);
        vm.prank(alice);
        registry.cancelUnstakeGuardian();

        assertTrue(registry.isActiveGuardian(alice));
        assertEq(registry.totalGuardianStake(), 10_000e18);
        assertEq(registry.activeGuardianCount(), 1);
    }

    function test_cancelUnstake_revertsIfNotRequested() public {
        vm.prank(alice);
        vm.expectRevert(IGuardianRegistry.UnstakeNotRequested.selector);
        registry.cancelUnstakeGuardian();
    }

    function test_claimUnstake_revertsBeforeCoolDown() public {
        vm.prank(alice);
        registry.requestUnstakeGuardian();
        uint256 requestedAt = block.timestamp;

        // Just before cool-down elapses, measured from unstakeRequestedAt
        vm.warp(requestedAt + COOL_DOWN - 1);
        vm.prank(alice);
        vm.expectRevert(IGuardianRegistry.CooldownNotElapsed.selector);
        registry.claimUnstakeGuardian();
    }

    function test_claimUnstake_transfersWoodBack() public {
        vm.prank(alice);
        registry.requestUnstakeGuardian();
        uint256 requestedAt = block.timestamp;

        uint256 balBefore = wood.balanceOf(alice);
        vm.warp(requestedAt + COOL_DOWN);

        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.GuardianUnstakeClaimed(alice, 10_000e18);
        vm.prank(alice);
        registry.claimUnstakeGuardian();

        assertEq(wood.balanceOf(alice), balBefore + 10_000e18);
        assertEq(wood.balanceOf(address(registry)), 0);
    }

    function test_claimUnstake_deletesGuardianStruct() public {
        vm.prank(alice);
        registry.requestUnstakeGuardian();
        vm.warp(block.timestamp + COOL_DOWN);
        vm.prank(alice);
        registry.claimUnstakeGuardian();

        assertEq(registry.guardianStake(alice), 0);
        assertFalse(registry.isActiveGuardian(alice));

        // Can re-register with a different agentId
        vm.prank(alice);
        registry.stakeAsGuardian(10_000e18, 77);
        assertEq(registry.guardianStake(alice), 10_000e18);
        assertTrue(registry.isActiveGuardian(alice));
        assertEq(registry.activeGuardianCount(), 1);
    }

    function test_claimUnstake_revertsIfNotRequested() public {
        vm.prank(alice);
        vm.expectRevert(IGuardianRegistry.UnstakeNotRequested.selector);
        registry.claimUnstakeGuardian();
    }
}

contract GuardianRegistryOwnerPrepareTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    address owner = address(0xA11CE);
    address governor = address(0x9000);
    address factory = address(0xFAC10);
    address creator = address(0xC0FFEE);

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, 0, 7 days, 24 hours, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        wood.mint(creator, 100_000e18);
        vm.prank(creator);
        wood.approve(address(registry), type(uint256).max);
    }

    function test_prepareOwnerStake_storesPrepared() public {
        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.OwnerStakePrepared(creator, 10_000e18);
        vm.prank(creator);
        registry.prepareOwnerStake(10_000e18);

        assertEq(registry.preparedStakeOf(creator), 10_000e18);
        assertTrue(registry.canCreateVault(creator));
        assertEq(wood.balanceOf(address(registry)), 10_000e18);
    }

    function test_prepareOwnerStake_revertsIfBelowMin() public {
        vm.prank(creator);
        vm.expectRevert(IGuardianRegistry.InsufficientStake.selector);
        registry.prepareOwnerStake(1);
    }

    function test_prepareOwnerStake_revertsIfAlreadyPrepared() public {
        vm.prank(creator);
        registry.prepareOwnerStake(10_000e18);
        vm.prank(creator);
        vm.expectRevert(IGuardianRegistry.PreparedStakeAlreadyExists.selector);
        registry.prepareOwnerStake(10_000e18);
    }

    function test_cancelPreparedStake_refunds() public {
        uint256 balBefore = wood.balanceOf(creator);
        vm.prank(creator);
        registry.prepareOwnerStake(10_000e18);

        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.PreparedStakeCancelled(creator, 10_000e18);
        vm.prank(creator);
        registry.cancelPreparedStake();

        assertEq(wood.balanceOf(creator), balBefore);
        assertEq(registry.preparedStakeOf(creator), 0);
        assertFalse(registry.canCreateVault(creator));
    }

    function test_cancelPreparedStake_revertsIfNone() public {
        vm.prank(creator);
        vm.expectRevert(IGuardianRegistry.PreparedStakeNotFound.selector);
        registry.cancelPreparedStake();
    }
}
