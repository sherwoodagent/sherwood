// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {GuardianRegistry} from "../src/GuardianRegistry.sol";
import {IGuardianRegistry} from "../src/interfaces/IGuardianRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockERC4626Vault} from "./mocks/MockERC4626Vault.sol";
import {MockGovernorMinimal} from "./mocks/MockGovernorMinimal.sol";
import {RevertingERC20Mock} from "./mocks/RevertingERC20Mock.sol";

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
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, 7 days, 24 hours, 3000)
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
            (owner, address(0), factory, address(wood), 10_000e18, 10_000e18, 7 days, 24 hours, 3000)
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
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, 7 days, 24 hours, 3000)
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
    }

    function test_stakeAsGuardian_topUp_accumulates_ignoresAgentIdChange() public {
        vm.prank(alice);
        registry.stakeAsGuardian(10_000e18, 42);
        vm.prank(alice);
        registry.stakeAsGuardian(5_000e18, 99); // different agentId should be ignored
        assertEq(registry.guardianStake(alice), 15_000e18);
        assertEq(registry.totalGuardianStake(), 15_000e18);
        // TODO: if an agentId view is added, assert it's still 42
    }

    function test_stakeAsGuardian_revertsIfBelowMinOnFirstStake() public {
        vm.prank(alice);
        vm.expectRevert(IGuardianRegistry.InsufficientStake.selector);
        registry.stakeAsGuardian(1, 42);
    }

    function test_stakeAsGuardian_NOT_frozen_while_paused() public {
        // Per spec: stake/unstake/claim paths MUST remain usable while paused so
        // guardians can exit. Pausing freezes review voting and claim/sweep,
        // not position management.
        vm.prank(owner);
        registry.pause();
        vm.prank(alice);
        registry.stakeAsGuardian(10_000e18, 42);
        assertEq(registry.guardianStake(alice), 10_000e18);
        assertTrue(registry.isActiveGuardian(alice));
    }

    function test_stakeAsGuardian_transfersWoodFromCaller() public {
        uint256 balBefore = wood.balanceOf(alice);
        vm.prank(alice);
        registry.stakeAsGuardian(10_000e18, 42);
        assertEq(wood.balanceOf(alice), balBefore - 10_000e18);
        assertEq(wood.balanceOf(address(registry)), 10_000e18);
    }

    // ── V1.5: checkpoint + getPastStake ──

    /// @notice Stake → top-up → partial state ops all push checkpoints that
    ///         `getPastStake` resolves historically. Closes the top-up-bias
    ///         vector: a guardian topping up after review-open reads the
    ///         pre-topup amount at the earlier timestamp.
    function test_getPastStake_returnsHistoricalValue() public {
        vm.prank(alice);
        registry.stakeAsGuardian(10_000e18, 42);
        uint256 t1 = vm.getBlockTimestamp();

        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(alice);
        registry.stakeAsGuardian(5_000e18, 42);
        uint256 t2 = vm.getBlockTimestamp();

        vm.warp(vm.getBlockTimestamp() + 1);

        assertEq(registry.getPastStake(alice, t1), 10_000e18, "at t1: first stake only");
        assertEq(registry.getPastStake(alice, t2), 15_000e18, "at t2: after top-up");
    }

    function test_getPastStake_zeroAfterRequestUnstake() public {
        vm.prank(alice);
        registry.stakeAsGuardian(10_000e18, 42);
        uint256 t1 = vm.getBlockTimestamp();

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        vm.prank(alice);
        registry.requestUnstakeGuardian();
        uint256 t2 = vm.getBlockTimestamp();

        vm.warp(vm.getBlockTimestamp() + 1);

        assertEq(registry.getPastStake(alice, t1), 10_000e18, "active at t1");
        assertEq(registry.getPastStake(alice, t2), 0, "0 at unstake-request time (not votable)");
    }

    function test_getPastTotalStake_tracksAggregate() public {
        vm.prank(alice);
        registry.stakeAsGuardian(10_000e18, 42);
        uint256 t1 = vm.getBlockTimestamp();

        vm.warp(vm.getBlockTimestamp() + 1);

        assertEq(registry.getPastTotalStake(t1), 10_000e18, "aggregate matches total after first stake");
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
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, COOL_DOWN, 24 hours, 3000)
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

        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.GuardianUnstakeRequested(alice, block.timestamp);
        vm.prank(alice);
        registry.requestUnstakeGuardian();

        assertFalse(registry.isActiveGuardian(alice));
        assertEq(registry.totalGuardianStake(), 0);
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
    }

    function test_cancelUnstake_revertsIfNotRequested() public {
        vm.prank(alice);
        vm.expectRevert(IGuardianRegistry.UnstakeNotRequested.selector);
        registry.cancelUnstakeGuardian();
    }

    /// @notice Regression for Bug A (fuzzer finding): topping up stake on a
    ///         guardian with a pending unstake would inflate
    ///         `totalGuardianStake` without making the guardian votable
    ///         (isActiveGuardian stays false because `unstakeRequestedAt != 0`).
    ///         The quorum denominator would outrun the real cohort. Must revert.
    function test_stakeAsGuardian_revertsIfUnstakeRequested() public {
        vm.prank(alice);
        registry.requestUnstakeGuardian();
        assertEq(registry.totalGuardianStake(), 0);

        vm.prank(alice);
        vm.expectRevert(IGuardianRegistry.UnstakeAlreadyRequested.selector);
        registry.stakeAsGuardian(10_000e18, 99);

        // Totals untouched.
        assertEq(registry.totalGuardianStake(), 0);
        assertFalse(registry.isActiveGuardian(alice));
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
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, 7 days, 24 hours, 3000)
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

contract GuardianRegistryOwnerBindTest is Test {
    using stdStorage for StdStorage;

    GuardianRegistry registry;
    ERC20Mock wood;
    MockERC4626Vault vault;
    address owner = address(0xA11CE);
    address governor = address(0x9000);
    address factory = address(0xFAC10);
    address creator = address(0xC0FFEE);
    address newCreator = address(0xC0FFEE2);
    address stranger = address(0xBAD);

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, 7 days, 24 hours, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        vault = new MockERC4626Vault();
        vault.setOwner(creator);

        wood.mint(creator, 100_000e18);
        vm.prank(creator);
        wood.approve(address(registry), type(uint256).max);
        wood.mint(newCreator, 100_000e18);
        vm.prank(newCreator);
        wood.approve(address(registry), type(uint256).max);
    }

    function test_bindOwnerStake_onlyFactory() public {
        vm.prank(creator);
        registry.prepareOwnerStake(10_000e18);

        vm.prank(stranger);
        vm.expectRevert(IGuardianRegistry.NotFactory.selector);
        registry.bindOwnerStake(creator, address(vault));
    }

    function test_bindOwnerStake_consumesPrepared() public {
        vm.prank(creator);
        registry.prepareOwnerStake(10_000e18);

        vm.expectEmit(true, true, false, true);
        emit IGuardianRegistry.OwnerStakeBound(creator, address(vault), 10_000e18);
        vm.prank(factory);
        registry.bindOwnerStake(creator, address(vault));

        // Prepared slot is consumed (still recorded but marked bound, so a fresh
        // prepareOwnerStake is allowed for this creator).
        assertFalse(registry.canCreateVault(creator));
        assertEq(registry.ownerStake(address(vault)), 10_000e18);
        assertTrue(registry.hasOwnerStake(address(vault)));
    }

    function test_bindOwnerStake_revertsIfNoPrepared() public {
        vm.prank(factory);
        vm.expectRevert(IGuardianRegistry.PreparedStakeNotFound.selector);
        registry.bindOwnerStake(creator, address(vault));
    }

    function test_bindOwnerStake_revertsIfBondInsufficient() public {
        // Creator prepares at the current floor.
        vm.prank(creator);
        registry.prepareOwnerStake(10_000e18);

        // Raise `minOwnerStake` above the prepared amount via direct storage
        // write (bypassing the timelock for test brevity). `requiredOwnerBond`
        // now returns 20_000e18, above the 10_000e18 prepared stake.
        stdstore.target(address(registry)).sig("minOwnerStake()").checked_write(uint256(20_000e18));

        vm.prank(factory);
        vm.expectRevert(IGuardianRegistry.OwnerBondInsufficient.selector);
        registry.bindOwnerStake(creator, address(vault));
    }

    function test_bindOwnerStake_revertsIfAlreadyBound() public {
        vm.prank(creator);
        registry.prepareOwnerStake(10_000e18);
        vm.prank(factory);
        registry.bindOwnerStake(creator, address(vault));

        vm.prank(factory);
        vm.expectRevert(IGuardianRegistry.PreparedStakeNotFound.selector);
        registry.bindOwnerStake(creator, address(vault));
    }

    function test_transferOwnerStakeSlot_reassigns() public {
        // Original owner binds.
        vm.prank(creator);
        registry.prepareOwnerStake(10_000e18);
        vm.prank(factory);
        registry.bindOwnerStake(creator, address(vault));

        // Simulate that the previous owner's stake has been slashed or fully
        // unstaked by zeroing _ownerStakes[vault].stakedAmount. We use stdstore
        // to write into the mapping slot for the OwnerStake struct's first 128
        // bits (`stakedAmount`). Simpler: prank the registry itself is not
        // feasible, so we expose this via a request+claim style in production;
        // here we write via a direct slot manipulation helper.
        // The struct lives at _ownerStakes[vault]. Slot math: find mapping slot
        // via stdstore (targets the getter) — ownerStake(vault) returns stakedAmount.
        stdstore.target(address(registry)).sig("ownerStake(address)").with_key(address(vault)).checked_write(uint256(0));

        // New owner prepares.
        vm.prank(newCreator);
        registry.prepareOwnerStake(10_000e18);

        vm.expectEmit(true, true, true, true);
        emit IGuardianRegistry.OwnerStakeSlotTransferred(address(vault), creator, newCreator);
        vm.prank(factory);
        registry.transferOwnerStakeSlot(address(vault), newCreator);

        assertEq(registry.ownerStake(address(vault)), 10_000e18);
        assertFalse(registry.canCreateVault(newCreator)); // consumed
    }

    function test_transferOwnerStakeSlot_revertsIfPreviousOwnerStillStaked() public {
        vm.prank(creator);
        registry.prepareOwnerStake(10_000e18);
        vm.prank(factory);
        registry.bindOwnerStake(creator, address(vault));

        vm.prank(newCreator);
        registry.prepareOwnerStake(10_000e18);

        vm.prank(factory);
        vm.expectRevert(IGuardianRegistry.PriorStakeNotCleared.selector);
        registry.transferOwnerStakeSlot(address(vault), newCreator);
    }

    function test_transferOwnerStakeSlot_onlyFactory() public {
        vm.prank(stranger);
        vm.expectRevert(IGuardianRegistry.NotFactory.selector);
        registry.transferOwnerStakeSlot(address(vault), newCreator);
    }
}

contract GuardianRegistryOwnerUnstakeTest is Test {
    using stdStorage for StdStorage;

    GuardianRegistry registry;
    ERC20Mock wood;
    MockERC4626Vault vault;
    MockGovernorMinimal governor;
    address owner = address(0xA11CE);
    address factory = address(0xFAC10);
    address creator = address(0xC0FFEE);
    address stranger = address(0xBAD);

    uint256 constant COOL_DOWN = 7 days;

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        governor = new MockGovernorMinimal();

        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, address(governor), factory, address(wood), 10_000e18, 10_000e18, COOL_DOWN, 24 hours, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        vault = new MockERC4626Vault();
        vault.setOwner(creator);

        wood.mint(creator, 100_000e18);
        vm.prank(creator);
        wood.approve(address(registry), type(uint256).max);

        // Creator prepares and binds an owner stake.
        vm.prank(creator);
        registry.prepareOwnerStake(10_000e18);
        vm.prank(factory);
        registry.bindOwnerStake(creator, address(vault));
    }

    function test_requestUnstakeOwner_setsTimestamp() public {
        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.OwnerUnstakeRequested(address(vault), block.timestamp);
        vm.prank(creator);
        registry.requestUnstakeOwner(address(vault));
    }

    function test_requestUnstakeOwner_revertsIfActiveProposal() public {
        // PR #229 Fix 2: `requestUnstakeOwner` now gates on `openProposalCount`
        // (Pending / GuardianReview / Approved / Executed) rather than only
        // `getActiveProposal` (Executed only). Prime the counter to simulate
        // a live proposal and verify the revert path still triggers.
        governor.setOpenProposalCount(address(vault), 1);
        vm.prank(creator);
        vm.expectRevert(IGuardianRegistry.VaultHasActiveProposal.selector);
        registry.requestUnstakeOwner(address(vault));
    }

    function test_requestUnstakeOwner_onlyCurrentOwner() public {
        vm.prank(stranger);
        vm.expectRevert(IGuardianRegistry.NoActiveStake.selector);
        registry.requestUnstakeOwner(address(vault));
    }

    function test_claimUnstakeOwner_afterCoolDown_transfersWood() public {
        vm.prank(creator);
        registry.requestUnstakeOwner(address(vault));
        uint256 requestedAt = block.timestamp;

        uint256 balBefore = wood.balanceOf(creator);
        vm.warp(requestedAt + COOL_DOWN);

        vm.expectEmit(true, true, false, true);
        emit IGuardianRegistry.OwnerUnstakeClaimed(address(vault), creator, 10_000e18);
        vm.prank(creator);
        registry.claimUnstakeOwner(address(vault));

        assertEq(wood.balanceOf(creator), balBefore + 10_000e18);
        assertEq(registry.ownerStake(address(vault)), 0);
        assertFalse(registry.hasOwnerStake(address(vault)));
    }

    function test_claimUnstakeOwner_revertsBeforeCoolDown() public {
        vm.prank(creator);
        registry.requestUnstakeOwner(address(vault));
        uint256 requestedAt = block.timestamp;

        vm.warp(requestedAt + COOL_DOWN - 1);
        vm.prank(creator);
        vm.expectRevert(IGuardianRegistry.CooldownNotElapsed.selector);
        registry.claimUnstakeOwner(address(vault));
    }

    function test_claimUnstakeOwner_revertsIfNotRequested() public {
        vm.prank(creator);
        vm.expectRevert(IGuardianRegistry.UnstakeNotRequested.selector);
        registry.claimUnstakeOwner(address(vault));
    }

    function test_claimUnstakeOwner_onlyCurrentOwner() public {
        vm.prank(creator);
        registry.requestUnstakeOwner(address(vault));
        vm.warp(block.timestamp + COOL_DOWN);

        vm.prank(stranger);
        vm.expectRevert(IGuardianRegistry.NoActiveStake.selector);
        registry.claimUnstakeOwner(address(vault));
    }
}

contract GuardianRegistryBondTest is Test {
    using stdStorage for StdStorage;

    GuardianRegistry registry;
    ERC20Mock wood;
    MockERC4626Vault vault;
    address owner = address(0xA11CE);
    address governor = address(0x9000);
    address factory = address(0xFAC10);

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, 7 days, 24 hours, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        vault = new MockERC4626Vault();
    }

    function test_requiredOwnerBond_returnsFloor() public {
        // Flat floor regardless of totalAssets.
        vault.setTotalAssets(1_000_000e18);
        assertEq(registry.requiredOwnerBond(address(vault)), 10_000e18);

        vault.setTotalAssets(0);
        assertEq(registry.requiredOwnerBond(address(vault)), 10_000e18);
    }
}

contract GuardianRegistryOpenReviewTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    MockGovernorMinimal governor;
    address owner = address(0xA11CE);
    address factory = address(0xFAC10);

    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant PROPOSAL_ID = 1;

    // Guardians pre-staked in setUp. `small` cohort (3 × 10_000e18 = 30_000e18)
    // is below MIN_COHORT_STAKE_AT_OPEN (50_000e18); `full` cohort (5 × 10_000e18
    // = 50_000e18) exactly meets the threshold.
    address[5] guardians = [address(0xAA01), address(0xAA02), address(0xAA03), address(0xAA04), address(0xAA05)];

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        governor = new MockGovernorMinimal();

        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, address(governor), factory, address(wood), 10_000e18, 10_000e18, 7 days, REVIEW_PERIOD, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        for (uint256 i = 0; i < guardians.length; i++) {
            wood.mint(guardians[i], 100_000e18);
            vm.prank(guardians[i]);
            wood.approve(address(registry), type(uint256).max);
        }
    }

    function _stakeN(uint256 n) internal {
        for (uint256 i = 0; i < n; i++) {
            vm.prank(guardians[i]);
            registry.stakeAsGuardian(10_000e18, 1 + i);
        }
    }

    function test_openReview_revertsBeforeVoteEnd() public {
        _stakeN(5);
        // voteEnd in future
        governor.setProposal(PROPOSAL_ID, block.timestamp + 1 hours, block.timestamp + 1 hours + REVIEW_PERIOD);
        vm.expectRevert(IGuardianRegistry.ReviewNotOpen.selector);
        registry.openReview(PROPOSAL_ID);
    }

    function test_openReview_revertsIfProposalMissing() public {
        // Unknown proposal → voteEnd == 0 → reverts
        vm.expectRevert(IGuardianRegistry.ReviewNotOpen.selector);
        registry.openReview(PROPOSAL_ID);
    }

    function test_openReview_snapshotsTotalStakeAtOpen() public {
        _stakeN(5); // 50_000e18 total
        uint256 ve = block.timestamp;
        governor.setProposal(PROPOSAL_ID, ve, ve + REVIEW_PERIOD);

        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.ReviewOpened(PROPOSAL_ID, 50_000e18);
        registry.openReview(PROPOSAL_ID);

        // Internal state surfaced through a couple of sanity paths:
        // second call must be a no-op (see idempotent test).
        assertEq(registry.totalGuardianStake(), 50_000e18);
    }

    function test_openReview_flagsCohortTooSmall() public {
        _stakeN(3); // 30_000e18 < 50_000e18 threshold
        uint256 ve = block.timestamp;
        governor.setProposal(PROPOSAL_ID, ve, ve + REVIEW_PERIOD);

        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.CohortTooSmallToReview(PROPOSAL_ID, 30_000e18);
        registry.openReview(PROPOSAL_ID);
    }

    function test_openReview_idempotent() public {
        _stakeN(5);
        uint256 ve = block.timestamp;
        governor.setProposal(PROPOSAL_ID, ve, ve + REVIEW_PERIOD);
        registry.openReview(PROPOSAL_ID);

        // Bump totalGuardianStake by staking a 6th guardian post-open.
        address g6 = address(0xA6);
        wood.mint(g6, 100_000e18);
        vm.prank(g6);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(g6);
        registry.stakeAsGuardian(10_000e18, 42);
        assertEq(registry.totalGuardianStake(), 60_000e18);

        // Second call is no-op — must NOT re-snapshot (would emit ReviewOpened again).
        // We ensure it doesn't revert and doesn't emit an event that would indicate
        // re-snapshotting by recording logs.
        vm.recordLogs();
        registry.openReview(PROPOSAL_ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
    }
}

contract GuardianRegistryVoteTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    MockGovernorMinimal governor;
    address owner = address(0xA11CE);
    address factory = address(0xFAC10);

    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant PROPOSAL_ID = 1;
    uint256 voteEnd;
    uint256 reviewEnd;

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        governor = new MockGovernorMinimal();

        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, address(governor), factory, address(wood), 10_000e18, 10_000e18, 7 days, REVIEW_PERIOD, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        // Stake 5 guardians × 10_000e18 = 50_000e18 to exactly meet MIN_COHORT_STAKE_AT_OPEN.
        for (uint256 i = 0; i < 5; i++) {
            address g = _guardian(i);
            wood.mint(g, 100_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
            vm.prank(g);
            registry.stakeAsGuardian(10_000e18, 1 + i);
        }

        // ToB C-1: openReview snapshots at `block.timestamp - 1`. Warp one
        // second so the stake checkpoints written in this setUp are visible
        // to the snapshot. Production flows have multi-block separation.
        vm.warp(vm.getBlockTimestamp() + 1);

        voteEnd = vm.getBlockTimestamp();
        reviewEnd = voteEnd + REVIEW_PERIOD;
        governor.setProposal(PROPOSAL_ID, voteEnd, reviewEnd);
    }

    function _guardian(uint256 i) internal pure returns (address) {
        return address(uint160(0xAA00 + i + 1));
    }

    function _openReview() internal {
        registry.openReview(PROPOSAL_ID);
    }

    function test_voteOnProposal_approve_updatesApprovers_andWeight() public {
        _openReview();
        address g = _guardian(0);

        vm.expectEmit(true, true, false, true);
        emit IGuardianRegistry.GuardianVoteCast(PROPOSAL_ID, g, IGuardianRegistry.GuardianVoteType.Approve, 10_000e18);
        vm.prank(g);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);
    }

    function test_voteOnProposal_block_updatesBlockers_andWeight() public {
        _openReview();
        address g = _guardian(1);

        vm.expectEmit(true, true, false, true);
        emit IGuardianRegistry.GuardianVoteCast(PROPOSAL_ID, g, IGuardianRegistry.GuardianVoteType.Block, 10_000e18);
        vm.prank(g);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);
    }

    function test_voteOnProposal_revertsIfReviewNotOpen() public {
        // openReview NOT called yet
        address g = _guardian(0);
        vm.prank(g);
        vm.expectRevert(IGuardianRegistry.ReviewNotOpen.selector);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);
    }

    function test_voteOnProposal_revertsAfterReviewEnd() public {
        _openReview();
        vm.warp(reviewEnd);
        address g = _guardian(0);
        vm.prank(g);
        vm.expectRevert(IGuardianRegistry.ReviewNotOpen.selector);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);
    }

    function test_voteOnProposal_revertsIfNotActiveGuardian() public {
        _openReview();
        address stranger = address(0xDEADBEEF);
        vm.prank(stranger);
        vm.expectRevert(IGuardianRegistry.NotActiveGuardian.selector);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);
    }

    function test_voteOnProposal_snapshotsStake() public {
        _openReview();
        address g = _guardian(0);

        // Top up AFTER openReview: snapshot weight is frozen at `r.openedAt`,
        // so the post-open top-up is NOT reflected in vote weight. Closes the
        // top-up-before-vote bias (see `voteOnProposal` header comment).
        vm.prank(g);
        registry.stakeAsGuardian(5_000e18, 42);
        assertEq(registry.guardianStake(g), 15_000e18);

        // First vote snapshots the pre-open weight = 10_000e18.
        vm.expectEmit(true, true, false, true);
        emit IGuardianRegistry.GuardianVoteCast(PROPOSAL_ID, g, IGuardianRegistry.GuardianVoteType.Block, 10_000e18);
        vm.prank(g);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);
    }

    function test_voteOnProposal_revertsIfSupportIsNone() public {
        _openReview();
        address g = _guardian(0);
        vm.prank(g);
        vm.expectRevert();
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.None);
    }

    function test_voteOnProposal_capHitEmitsEventAndReverts() public {
        // Stake 100 fresh guardians BEFORE openReview so C-1's
        // `openedAt = block.timestamp - 1` snapshot can see their stake.
        uint256 cap = registry.MAX_APPROVERS_PER_PROPOSAL();
        for (uint256 i = 0; i < cap; i++) {
            address g = address(uint160(0x100000 + i));
            wood.mint(g, 100_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
            vm.prank(g);
            registry.stakeAsGuardian(10_000e18, 1 + i);
        }
        // 101st staker (must also be staked pre-open so the cap-rejection
        // path is the revert we hit, not a stake-timing miss).
        address last = address(uint160(0x100000 + cap));
        wood.mint(last, 100_000e18);
        vm.prank(last);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(last);
        registry.stakeAsGuardian(10_000e18, 999);

        vm.warp(vm.getBlockTimestamp() + 1);
        // Re-sync MockGovernorMinimal so `voteEnd < block.timestamp < reviewEnd`.
        uint256 newVoteEnd = vm.getBlockTimestamp();
        governor.setProposal(PROPOSAL_ID, newVoteEnd, newVoteEnd + REVIEW_PERIOD);
        _openReview();

        for (uint256 i = 0; i < cap; i++) {
            address g = address(uint160(0x100000 + i));
            vm.prank(g);
            registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);
        }

        vm.expectEmit(true, false, false, false);
        emit IGuardianRegistry.ApproverCapReached(PROPOSAL_ID);
        vm.prank(last);
        vm.expectRevert(IGuardianRegistry.NewSideFull.selector);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);

        // 101st Block succeeds — blockers uncapped.
        vm.prank(last);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);
    }

    /// @notice ToB I-2 regression: blockers are capped at
    /// `MAX_BLOCKERS_PER_PROPOSAL` so the `_emitBlockerAttribution` loop in
    /// `resolveReview` is bounded. The 101st block vote reverts `NewSideFull`
    /// and emits `BlockerCapReached`.
    function test_voteOnProposal_blockerCapHitEmitsEventAndReverts() public {
        uint256 cap = registry.MAX_BLOCKERS_PER_PROPOSAL();
        for (uint256 i = 0; i < cap; i++) {
            address g = address(uint160(0x300000 + i));
            wood.mint(g, 100_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
            vm.prank(g);
            registry.stakeAsGuardian(10_000e18, 1 + i);
        }
        address last = address(uint160(0x300000 + cap));
        wood.mint(last, 100_000e18);
        vm.prank(last);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(last);
        registry.stakeAsGuardian(10_000e18, 999);

        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 newPid = 42;
        governor.setProposal(newPid, vm.getBlockTimestamp(), vm.getBlockTimestamp() + REVIEW_PERIOD);
        registry.openReview(newPid);

        for (uint256 i = 0; i < cap; i++) {
            address g = address(uint160(0x300000 + i));
            vm.prank(g);
            registry.voteOnProposal(newPid, IGuardianRegistry.GuardianVoteType.Block);
        }

        vm.expectEmit(true, false, false, false);
        emit IGuardianRegistry.BlockerCapReached(newPid);
        vm.prank(last);
        vm.expectRevert(IGuardianRegistry.NewSideFull.selector);
        registry.voteOnProposal(newPid, IGuardianRegistry.GuardianVoteType.Block);
    }
}

contract GuardianRegistryVoteChangeTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    MockGovernorMinimal governor;
    address owner = address(0xA11CE);
    address factory = address(0xFAC10);

    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant PROPOSAL_ID = 1;
    uint256 voteEnd;
    uint256 reviewEnd;

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        governor = new MockGovernorMinimal();

        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, address(governor), factory, address(wood), 10_000e18, 10_000e18, 7 days, REVIEW_PERIOD, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        for (uint256 i = 0; i < 5; i++) {
            address g = _guardian(i);
            wood.mint(g, 100_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
            vm.prank(g);
            registry.stakeAsGuardian(10_000e18, 1 + i);
        }

        // ToB C-1: warp past stake checkpoints so openReview's
        // `openedAt = block.timestamp - 1` snapshot can see them.
        vm.warp(vm.getBlockTimestamp() + 1);

        voteEnd = vm.getBlockTimestamp();
        reviewEnd = voteEnd + REVIEW_PERIOD;
        governor.setProposal(PROPOSAL_ID, voteEnd, reviewEnd);
        registry.openReview(PROPOSAL_ID);
    }

    function _guardian(uint256 i) internal pure returns (address) {
        return address(uint160(0xAA00 + i + 1));
    }

    function test_voteChange_approveToBlock_updatesArraysAndTallies() public {
        address g = _guardian(0);
        vm.prank(g);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);

        // Top up stake AFTER first vote: should NOT be reflected on swap
        // (vote-change preserves the original snapshot).
        vm.prank(g);
        registry.stakeAsGuardian(5_000e18, 42);

        vm.expectEmit(true, true, false, true);
        emit IGuardianRegistry.GuardianVoteChanged(
            PROPOSAL_ID, g, IGuardianRegistry.GuardianVoteType.Approve, IGuardianRegistry.GuardianVoteType.Block
        );
        vm.prank(g);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);

        // Now switch back to Approve → still original 10_000e18 weight
        // (stake snapshot is first-vote only).
        vm.expectEmit(true, true, false, true);
        emit IGuardianRegistry.GuardianVoteChanged(
            PROPOSAL_ID, g, IGuardianRegistry.GuardianVoteType.Block, IGuardianRegistry.GuardianVoteType.Approve
        );
        vm.prank(g);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);
    }

    function test_voteChange_sameSide_revertsNoVoteChange() public {
        address g = _guardian(0);
        vm.prank(g);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);

        vm.prank(g);
        vm.expectRevert(IGuardianRegistry.NoVoteChange.selector);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);
    }

    function test_voteChange_inLockoutWindow_reverts() public {
        address g = _guardian(0);
        vm.prank(g);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);

        // Lockout = final 10% of reviewPeriod. For 24h window → final 2.4h.
        // Warp to exactly lockoutStart (reviewEnd - reviewPeriod*1000/10000).
        uint256 lockoutStart = reviewEnd - (REVIEW_PERIOD * 1000) / 10_000;
        vm.warp(lockoutStart);

        vm.prank(g);
        vm.expectRevert(IGuardianRegistry.VoteChangeLockedOut.selector);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);
    }

    function test_voteChange_justBeforeLockout_succeeds() public {
        address g = _guardian(0);
        vm.prank(g);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);

        // One second before lockout starts — still allowed.
        uint256 lockoutStart = reviewEnd - (REVIEW_PERIOD * 1000) / 10_000;
        vm.warp(lockoutStart - 1);

        vm.prank(g);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);
    }

    function test_voteChange_blockToApprove_revertsIfApproverCapFull() public {
        // Existing 5 guardians will vote Block first; then saturate Approve with 100 fresh guardians.
        // ToB C-1: fresh guardians must stake BEFORE openReview was called in
        // setUp to be visible via the `openedAt = block.timestamp - 1` snapshot.
        // Since setUp already opened the review, we use guardians whose stake
        // was already visible — reuse existing cohort + switch semantic.
        // Work around by cancelling the review setup and re-opening AFTER the
        // 100 fresh stakes plus a warp.
        // Simpler: use a separate proposal opened after staking.
        uint256 cap = registry.MAX_APPROVERS_PER_PROPOSAL();
        for (uint256 i = 0; i < cap; i++) {
            address g = address(uint160(0x200000 + i));
            wood.mint(g, 100_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
            vm.prank(g);
            registry.stakeAsGuardian(10_000e18, 1 + i);
        }
        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 newPid = 2;
        governor.setProposal(newPid, vm.getBlockTimestamp(), vm.getBlockTimestamp() + REVIEW_PERIOD);
        registry.openReview(newPid);

        address blockVoter = _guardian(0);
        vm.prank(blockVoter);
        registry.voteOnProposal(newPid, IGuardianRegistry.GuardianVoteType.Block);

        for (uint256 i = 0; i < cap; i++) {
            address g = address(uint160(0x200000 + i));
            vm.prank(g);
            registry.voteOnProposal(newPid, IGuardianRegistry.GuardianVoteType.Approve);
        }

        // Block voter tries to switch → must revert NewSideFull WITHOUT mutating
        // the old side (check-first-then-apply).
        vm.prank(blockVoter);
        vm.expectRevert(IGuardianRegistry.NewSideFull.selector);
        registry.voteOnProposal(newPid, IGuardianRegistry.GuardianVoteType.Approve);

        // Verify blockVoter still holds their Block vote (old side intact).
        vm.prank(blockVoter);
        vm.expectRevert(IGuardianRegistry.NoVoteChange.selector);
        registry.voteOnProposal(newPid, IGuardianRegistry.GuardianVoteType.Block);
    }
}

contract GuardianRegistryResolveTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    MockGovernorMinimal governor;
    address owner = address(0xA11CE);
    address factory = address(0xFAC10);

    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant PROPOSAL_ID = 1;
    uint256 constant BLOCK_QUORUM_BPS = 3000; // 30%
    uint256 voteEnd;
    uint256 reviewEnd;

    address internal constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

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
                10_000e18,
                10_000e18,
                7 days,
                REVIEW_PERIOD,
                BLOCK_QUORUM_BPS
            )
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        // Stake 5 guardians × 10_000e18 = 50_000e18 — matches MIN_COHORT_STAKE_AT_OPEN.
        for (uint256 i = 0; i < 5; i++) {
            address g = _guardian(i);
            wood.mint(g, 100_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
            vm.prank(g);
            registry.stakeAsGuardian(10_000e18, 1 + i);
        }

        // ToB C-1: warp past stake checkpoints so openReview's
        // `openedAt = block.timestamp - 1` snapshot can see them.
        vm.warp(vm.getBlockTimestamp() + 1);

        voteEnd = vm.getBlockTimestamp();
        reviewEnd = voteEnd + REVIEW_PERIOD;
        governor.setProposal(PROPOSAL_ID, voteEnd, reviewEnd);
    }

    function _guardian(uint256 i) internal pure returns (address) {
        return address(uint160(0xAA00 + i + 1));
    }

    function _openAndVote(IGuardianRegistry.GuardianVoteType[5] memory sides) internal {
        registry.openReview(PROPOSAL_ID);
        for (uint256 i = 0; i < 5; i++) {
            if (sides[i] == IGuardianRegistry.GuardianVoteType.None) continue;
            vm.prank(_guardian(i));
            registry.voteOnProposal(PROPOSAL_ID, sides[i]);
        }
    }

    function test_resolveReview_revertsBeforeReviewEnd() public {
        registry.openReview(PROPOSAL_ID);
        // Warp to reviewEnd - 1 (still inside the window).
        vm.warp(reviewEnd - 1);
        vm.expectRevert(IGuardianRegistry.ReviewNotReadyForResolve.selector);
        registry.resolveReview(PROPOSAL_ID);
    }

    function test_resolveReview_noReviewOpened_returnsFalse() public {
        // openReview never called, but reviewEnd stamped on the governor.
        vm.warp(reviewEnd);
        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.ReviewResolved(PROPOSAL_ID, false, 0);
        bool blocked = registry.resolveReview(PROPOSAL_ID);
        assertFalse(blocked);
        // No slashing — burn address still empty, total stake intact.
        assertEq(wood.balanceOf(BURN_ADDRESS), 0);
        assertEq(registry.totalGuardianStake(), 50_000e18);
    }

    function test_resolveReview_belowQuorum_returnsFalse_noSlash() public {
        // 2 Approves, 1 Block → block weight = 10_000 = 20% of 50_000 < 30%.
        IGuardianRegistry.GuardianVoteType[5] memory sides = [
            IGuardianRegistry.GuardianVoteType.Approve,
            IGuardianRegistry.GuardianVoteType.Approve,
            IGuardianRegistry.GuardianVoteType.Block,
            IGuardianRegistry.GuardianVoteType.None,
            IGuardianRegistry.GuardianVoteType.None
        ];
        _openAndVote(sides);

        vm.warp(reviewEnd);
        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.ReviewResolved(PROPOSAL_ID, false, 0);
        bool blocked = registry.resolveReview(PROPOSAL_ID);

        assertFalse(blocked);
        assertEq(wood.balanceOf(BURN_ADDRESS), 0);
        // Approvers keep their stake.
        assertEq(registry.guardianStake(_guardian(0)), 10_000e18);
        assertEq(registry.guardianStake(_guardian(1)), 10_000e18);
        assertEq(registry.totalGuardianStake(), 50_000e18);
    }

    function test_resolveReview_quorumReached_slashesApprovers_burnsWood() public {
        // 2 Approves, 2 Blocks → block weight = 20_000 = 40% of 50_000 >= 30%.
        IGuardianRegistry.GuardianVoteType[5] memory sides = [
            IGuardianRegistry.GuardianVoteType.Approve,
            IGuardianRegistry.GuardianVoteType.Approve,
            IGuardianRegistry.GuardianVoteType.Block,
            IGuardianRegistry.GuardianVoteType.Block,
            IGuardianRegistry.GuardianVoteType.None
        ];
        _openAndVote(sides);

        uint256 totalStakeBefore = registry.totalGuardianStake();
        uint256 slashTotal = 20_000e18; // 2 approvers × 10_000e18

        vm.warp(reviewEnd);
        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.ReviewResolved(PROPOSAL_ID, true, slashTotal);
        bool blocked = registry.resolveReview(PROPOSAL_ID);

        assertTrue(blocked);
        // WOOD moved to burn address.
        assertEq(wood.balanceOf(BURN_ADDRESS), slashTotal);
        // Each approver's stake zeroed.
        assertEq(registry.guardianStake(_guardian(0)), 0);
        assertEq(registry.guardianStake(_guardian(1)), 0);
        // Block voters keep their stake.
        assertEq(registry.guardianStake(_guardian(2)), 10_000e18);
        assertEq(registry.guardianStake(_guardian(3)), 10_000e18);
        // Aggregate totals decremented.
        assertEq(registry.totalGuardianStake(), totalStakeBefore - slashTotal);
        // V1.5: epoch block-weight tracking moved to Merkl. Attribution now
        // lives in the `BlockerAttributed` event — covered in Phase 3 tests.
    }

    function test_resolveReview_cohortTooSmall_returnsFalseEvenWithBlockVotes() public {
        // Start a fresh registry with only 3 guardians staked to fall below the
        // 50_000e18 MIN_COHORT_STAKE_AT_OPEN threshold. Reset all 5 by
        // requesting unstake on 2 of them; they leave totalGuardianStake
        // immediately, taking the cohort down to 30_000e18.
        vm.prank(_guardian(3));
        registry.requestUnstakeGuardian();
        vm.prank(_guardian(4));
        registry.requestUnstakeGuardian();
        assertEq(registry.totalGuardianStake(), 30_000e18);

        // Open review with the smaller cohort → cohortTooSmall flag set.
        registry.openReview(PROPOSAL_ID);
        // Remaining 3 active guardians all vote Block — would be 100% block
        // weight, but cohort flag short-circuits to false.
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(_guardian(i));
            registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);
        }

        vm.warp(reviewEnd);
        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.ReviewResolved(PROPOSAL_ID, false, 0);
        bool blocked = registry.resolveReview(PROPOSAL_ID);
        assertFalse(blocked);
        assertEq(wood.balanceOf(BURN_ADDRESS), 0);
    }

    /// @notice Regression for PR #229 fix: `_slashApprovers` must slash the
    ///         `_voteStake` snapshot captured at vote time, NOT the live
    ///         `stakedAmount`. A guardian that tops up between voting and
    ///         resolution should only lose the snapshot weight, not the top-up.
    function test_resolveReview_slashesOnlyVoteSnapshot_notTopUp() public {
        // Approver has 10_000e18 staked at setUp. Cast an Approve vote first so
        // the snapshot is captured, then top-up to 20_000e18 before resolving.
        address approver = _guardian(0);
        registry.openReview(PROPOSAL_ID);
        vm.prank(approver);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);

        // Top up AFTER voting — should not enlarge the slash.
        vm.prank(approver);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(approver);
        registry.stakeAsGuardian(10_000e18, 1);
        assertEq(registry.guardianStake(approver), 20_000e18);

        // 2 Block votes hit quorum: blockStakeWeight / totalStakeAtOpen =
        // 20_000 / 50_000 = 40% >= 30%.
        vm.prank(_guardian(1));
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);
        vm.prank(_guardian(2));
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);

        vm.warp(reviewEnd);
        bool blocked = registry.resolveReview(PROPOSAL_ID);
        assertTrue(blocked);

        // Slashed only the 10_000e18 snapshot weight, not the 20_000e18 live stake.
        assertEq(registry.guardianStake(approver), 10_000e18, "only vote-weight slashed");
        assertEq(wood.balanceOf(BURN_ADDRESS), 10_000e18, "burn equals snapshot");
        // Guardian still active (remaining stake > 0).
        assertTrue(registry.isActiveGuardian(approver), "still active with residual stake");
    }

    function test_resolveReview_idempotent() public {
        IGuardianRegistry.GuardianVoteType[5] memory sides = [
            IGuardianRegistry.GuardianVoteType.Approve,
            IGuardianRegistry.GuardianVoteType.Block,
            IGuardianRegistry.GuardianVoteType.Block,
            IGuardianRegistry.GuardianVoteType.None,
            IGuardianRegistry.GuardianVoteType.None
        ];
        _openAndVote(sides);

        vm.warp(reviewEnd);
        bool first = registry.resolveReview(PROPOSAL_ID);
        assertTrue(first);
        uint256 burnedBalance = wood.balanceOf(BURN_ADDRESS);

        // Second call must return cached result, no extra slashing, no extra event.
        vm.recordLogs();
        bool second = registry.resolveReview(PROPOSAL_ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
        assertEq(second, first);
        assertEq(wood.balanceOf(BURN_ADDRESS), burnedBalance);
    }

    /// @notice Regression for Bug B (fuzzer finding): a guardian who voted
    ///         Approve, then requested unstake before `resolveReview`, gets
    ///         slashed when the review resolves as blocked. Before the fix,
    ///         `cancelUnstakeGuardian()` would still restore
    ///         `activeGuardianCount` despite `stakedAmount == 0`, creating a
    ///         ghost-active guardian. After the fix: `_slashApprovers` clears
    ///         `unstakeRequestedAt` as defense-in-depth, and
    ///         `cancelUnstakeGuardian` guards `stakedAmount > 0` so a naked
    ///         cancel post-slash would revert.
    function test_cancelUnstake_revertsIfSlashed() public {
        // 1) Open review and cast the approve vote while guardian 0 is still active.
        registry.openReview(PROPOSAL_ID);
        address approver = _guardian(0);
        vm.prank(approver);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);

        // 2) Two other guardians cast Block votes → 20_000e18 >= 30% of 50_000e18.
        vm.prank(_guardian(1));
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);
        vm.prank(_guardian(2));
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);

        // 3) Approver requests unstake between vote and resolve.
        vm.prank(approver);
        registry.requestUnstakeGuardian();
        assertFalse(registry.isActiveGuardian(approver));

        // 4) Resolve → blocked → slashes the approver. Because the unstake
        //    request already decremented totals, `_slashApprovers` must NOT
        //    decrement them again — and must clear `unstakeRequestedAt` as
        //    defense in depth.
        vm.warp(reviewEnd);
        bool blocked = registry.resolveReview(PROPOSAL_ID);
        assertTrue(blocked);
        assertEq(registry.guardianStake(approver), 0);
        // Counters unchanged by the slash (already decremented at request time).

        // 5) The ghost-cancel attack: approver tries to cancel the unstake to
        //    re-enter active status. `_slashApprovers` cleared
        //    `unstakeRequestedAt`, so the first gate hit is `UnstakeNotRequested`.
        vm.prank(approver);
        vm.expectRevert(IGuardianRegistry.UnstakeNotRequested.selector);
        registry.cancelUnstakeGuardian();
    }
}

contract GuardianRegistryBurnTest is Test {
    GuardianRegistry registry;
    RevertingERC20Mock wood;
    MockGovernorMinimal governor;
    address owner = address(0xA11CE);
    address factory = address(0xFAC10);

    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant PROPOSAL_ID = 1;
    uint256 constant BLOCK_QUORUM_BPS = 3000; // 30%

    address internal constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        wood = new RevertingERC20Mock("WOOD", "WOOD", 18);
        governor = new MockGovernorMinimal();

        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (
                owner,
                address(governor),
                factory,
                address(wood),
                10_000e18,
                10_000e18,
                7 days,
                REVIEW_PERIOD,
                BLOCK_QUORUM_BPS
            )
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));
    }

    function _guardian(uint256 i) internal pure returns (address) {
        return address(uint160(0xAA00 + i + 1));
    }

    function test_flushBurn_noopWhenZero() public {
        // No pending burn → call must no-op cleanly, no transfer, no emission.
        vm.recordLogs();
        registry.flushBurn();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
        assertEq(wood.balanceOf(BURN_ADDRESS), 0);
    }

    function test_flushBurn_retriesPendingBurn() public {
        // Stand up a 5-guardian cohort and 2-Approve / 2-Block tally → quorum
        // met, slash targets 20_000e18.
        for (uint256 i = 0; i < 5; i++) {
            address g = _guardian(i);
            wood.mint(g, 100_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
            vm.prank(g);
            registry.stakeAsGuardian(10_000e18, 1 + i);
        }
        // ToB C-1: warp past stake checkpoints so openReview's
        // `openedAt = block.timestamp - 1` snapshot can see them.
        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 voteEnd_ = vm.getBlockTimestamp();
        uint256 reviewEnd_ = voteEnd_ + REVIEW_PERIOD;
        governor.setProposal(PROPOSAL_ID, voteEnd_, reviewEnd_);
        registry.openReview(PROPOSAL_ID);

        vm.prank(_guardian(0));
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);
        vm.prank(_guardian(1));
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);
        vm.prank(_guardian(2));
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);
        vm.prank(_guardian(3));
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);

        // Block transfers TO the burn address — the slash-path transfer must
        // fail and route into _pendingBurn, emitting PendingBurnRecorded.
        wood.setTransferBlocked(BURN_ADDRESS, true);

        vm.warp(reviewEnd_);
        vm.expectEmit(false, false, false, true);
        emit IGuardianRegistry.PendingBurnRecorded(20_000e18);
        bool blocked = registry.resolveReview(PROPOSAL_ID);
        assertTrue(blocked);
        // Burn address still empty — amount queued instead.
        assertEq(wood.balanceOf(BURN_ADDRESS), 0);
        // Registry still holds the slashed WOOD.
        assertEq(wood.balanceOf(address(registry)), 50_000e18);

        // Unblock and retry via flushBurn — must transfer + emit BurnFlushed.
        wood.setTransferBlocked(BURN_ADDRESS, false);
        vm.expectEmit(false, false, false, true);
        emit IGuardianRegistry.BurnFlushed(20_000e18);
        registry.flushBurn();

        assertEq(wood.balanceOf(BURN_ADDRESS), 20_000e18);
        assertEq(wood.balanceOf(address(registry)), 30_000e18);

        // Second call after queue is drained → no-op.
        vm.recordLogs();
        registry.flushBurn();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
    }
}

contract GuardianRegistryEmergencyTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    MockGovernorMinimal governor;
    MockERC4626Vault vault;
    address owner = address(0xA11CE);
    address factory = address(0xFAC10);
    address creator = address(0xC0FFEE);
    address stranger = address(0xBAD);

    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant PROPOSAL_ID = 1;
    uint256 constant BLOCK_QUORUM_BPS = 3000; // 30%

    address internal constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

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
                10_000e18,
                10_000e18,
                7 days,
                REVIEW_PERIOD,
                BLOCK_QUORUM_BPS
            )
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        vault = new MockERC4626Vault();
        vault.setOwner(creator);

        // Bind an owner stake for the vault so emergency slashing has a
        // target. Creator mints, prepares, factory binds.
        wood.mint(creator, 100_000e18);
        vm.prank(creator);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(creator);
        registry.prepareOwnerStake(10_000e18);
        vm.prank(factory);
        registry.bindOwnerStake(creator, address(vault));

        // Stake 5 guardians × 10_000e18 = 50_000e18 to match MIN_COHORT_STAKE_AT_OPEN.
        for (uint256 i = 0; i < 5; i++) {
            address g = _guardian(i);
            wood.mint(g, 100_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
            vm.prank(g);
            registry.stakeAsGuardian(10_000e18, 1 + i);
        }

        // ToB C-1: warp past stake checkpoints so openEmergencyReview's
        // `openedAt = block.timestamp - 1` snapshot can see them.
        vm.warp(vm.getBlockTimestamp() + 1);
    }

    function _guardian(uint256 i) internal pure returns (address) {
        return address(uint160(0xAA00 + i + 1));
    }

    function _openEmergency() internal returns (uint64 reviewEnd_) {
        // Wire up the governor's ProposalView so _slashOwner can resolve vault.
        reviewEnd_ = uint64(vm.getBlockTimestamp() + REVIEW_PERIOD);
        governor.setProposalWithVault(PROPOSAL_ID, vm.getBlockTimestamp(), reviewEnd_, address(vault));
        vm.prank(address(governor));
        registry.openEmergencyReview(PROPOSAL_ID, keccak256("calls"));
    }

    function test_openEmergencyReview_onlyGovernor() public {
        vm.prank(stranger);
        vm.expectRevert(IGuardianRegistry.NotGovernor.selector);
        registry.openEmergencyReview(PROPOSAL_ID, keccak256("calls"));
    }

    function test_openEmergencyReview_snapshotsTotalStakeAtOpen() public {
        // Use a tight quorum setup that straddles the 30% bps boundary:
        // Open with totalGuardianStake = 50_000e18 (snapshot). After opening,
        // stake 5 more guardians → live total = 100_000e18. Cast 2 block
        // votes for 20_000e18 block weight.
        //   - Against snapshot (50_000e18): 20_000/50_000 = 40% >= 30% → blocked
        //   - Against live total (100_000e18): 20_000/100_000 = 20% < 30% → not blocked
        // A true snapshot returns `blocked = true`; a bug that reads live
        // total at resolve time would return `false`. This asserts the
        // snapshot semantics.
        uint64 expectedEnd = uint64(block.timestamp + REVIEW_PERIOD);
        bytes32 h = keccak256("calls");
        governor.setProposalWithVault(PROPOSAL_ID, block.timestamp, expectedEnd, address(vault));
        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.EmergencyReviewOpened(PROPOSAL_ID, h, expectedEnd);
        vm.prank(address(governor));
        registry.openEmergencyReview(PROPOSAL_ID, h);

        // Stake 5 additional guardians post-open → live total jumps to 100_000e18.
        for (uint256 i = 5; i < 10; i++) {
            address g = address(uint160(0xBB00 + i));
            wood.mint(g, 100_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
            vm.prank(g);
            registry.stakeAsGuardian(10_000e18, 1 + i);
        }
        assertEq(registry.totalGuardianStake(), 100_000e18);

        // 2 block votes from original cohort → 20_000e18 block weight.
        vm.prank(_guardian(0));
        registry.voteBlockEmergencySettle(PROPOSAL_ID);
        vm.prank(_guardian(1));
        registry.voteBlockEmergencySettle(PROPOSAL_ID);

        vm.warp(expectedEnd);
        bool blocked = registry.resolveEmergencyReview(PROPOSAL_ID);
        // Quorum computed against the 50_000e18 snapshot → blocked.
        assertTrue(blocked);
    }

    function test_voteBlockEmergencySettle_updatesTally() public {
        uint64 reviewEnd_ = _openEmergency();
        (reviewEnd_);

        vm.expectEmit(true, true, false, true);
        emit IGuardianRegistry.EmergencyBlockVoteCast(PROPOSAL_ID, _guardian(0), 10_000e18);
        vm.prank(_guardian(0));
        registry.voteBlockEmergencySettle(PROPOSAL_ID);
    }

    function test_voteBlockEmergencySettle_revertsIfDoubleVote() public {
        _openEmergency();
        vm.prank(_guardian(0));
        registry.voteBlockEmergencySettle(PROPOSAL_ID);

        vm.prank(_guardian(0));
        vm.expectRevert(IGuardianRegistry.AlreadyVoted.selector);
        registry.voteBlockEmergencySettle(PROPOSAL_ID);
    }

    function test_resolveEmergencyReview_beforeEnd_reverts() public {
        uint64 reviewEnd_ = _openEmergency();
        vm.warp(reviewEnd_ - 1);
        vm.expectRevert(IGuardianRegistry.ReviewNotReadyForResolve.selector);
        registry.resolveEmergencyReview(PROPOSAL_ID);
    }

    function test_resolveEmergencyReview_belowQuorum_returnsFalse() public {
        uint64 reviewEnd_ = _openEmergency();
        // 1 blocker = 10_000e18 = 20% of 50_000e18 < 30% → false.
        vm.prank(_guardian(0));
        registry.voteBlockEmergencySettle(PROPOSAL_ID);

        vm.warp(reviewEnd_);
        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.EmergencyReviewResolved(PROPOSAL_ID, false, 0);
        bool blocked = registry.resolveEmergencyReview(PROPOSAL_ID);
        assertFalse(blocked);
        // Owner stake intact.
        assertEq(registry.ownerStake(address(vault)), 10_000e18);
        assertEq(wood.balanceOf(BURN_ADDRESS), 0);
    }

    function test_resolveEmergencyReview_quorumReached_slashesOwner_burnsWood() public {
        uint64 reviewEnd_ = _openEmergency();
        // 2 blockers = 20_000e18 = 40% of 50_000e18 >= 30% → blocked.
        vm.prank(_guardian(0));
        registry.voteBlockEmergencySettle(PROPOSAL_ID);
        vm.prank(_guardian(1));
        registry.voteBlockEmergencySettle(PROPOSAL_ID);

        uint256 ownerStakeBefore = registry.ownerStake(address(vault));
        assertEq(ownerStakeBefore, 10_000e18);

        vm.warp(reviewEnd_);
        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.EmergencyReviewResolved(PROPOSAL_ID, true, 10_000e18);
        bool blocked = registry.resolveEmergencyReview(PROPOSAL_ID);

        assertTrue(blocked);
        assertEq(registry.ownerStake(address(vault)), 0);
        assertEq(wood.balanceOf(BURN_ADDRESS), 10_000e18);
    }

    function test_resolveEmergencyReview_cohortTooSmall_returnsFalse() public {
        // Drain guardians down to 30_000e18 (below 50_000 threshold).
        vm.prank(_guardian(3));
        registry.requestUnstakeGuardian();
        vm.prank(_guardian(4));
        registry.requestUnstakeGuardian();
        assertEq(registry.totalGuardianStake(), 30_000e18);

        // Note: openEmergencyReview always snapshots totalGuardianStake
        // without a MIN_COHORT check — the cold-start fallback here is the
        // `totalStakeAtOpen == 0` branch, not MIN_COHORT. So we drain all
        // stake to 0 to exercise the cohort-too-small-for-emergency path.
        vm.prank(_guardian(0));
        registry.requestUnstakeGuardian();
        vm.prank(_guardian(1));
        registry.requestUnstakeGuardian();
        vm.prank(_guardian(2));
        registry.requestUnstakeGuardian();
        assertEq(registry.totalGuardianStake(), 0);

        uint64 reviewEnd_ = _openEmergency();
        // No active guardians left → no votes possible. Even if there were,
        // totalStakeAtOpen == 0 short-circuits the quorum calc to false.
        vm.warp(reviewEnd_);
        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.EmergencyReviewResolved(PROPOSAL_ID, false, 0);
        bool blocked = registry.resolveEmergencyReview(PROPOSAL_ID);
        assertFalse(blocked);
        assertEq(registry.ownerStake(address(vault)), 10_000e18);
        assertEq(wood.balanceOf(BURN_ADDRESS), 0);
    }

    function test_resolveEmergencyReview_idempotent() public {
        uint64 reviewEnd_ = _openEmergency();
        vm.prank(_guardian(0));
        registry.voteBlockEmergencySettle(PROPOSAL_ID);
        vm.prank(_guardian(1));
        registry.voteBlockEmergencySettle(PROPOSAL_ID);

        vm.warp(reviewEnd_);
        bool first = registry.resolveEmergencyReview(PROPOSAL_ID);
        assertTrue(first);
        uint256 burnedBalance = wood.balanceOf(BURN_ADDRESS);

        vm.recordLogs();
        bool second = registry.resolveEmergencyReview(PROPOSAL_ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0);
        assertEq(second, first);
        assertEq(wood.balanceOf(BURN_ADDRESS), burnedBalance);
    }
}

contract GuardianRegistryAppealTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    address owner = address(0xA11CE);
    address governor = address(0x9000);
    address factory = address(0xFAC10);
    address recipient = address(0xBEEF);
    address stranger = address(0xBAD);

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, 7 days, 24 hours, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        wood.mint(owner, 1_000_000e18);
        vm.prank(owner);
        wood.approve(address(registry), type(uint256).max);
    }

    function test_fundSlashAppealReserve_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        registry.fundSlashAppealReserve(1_000e18);
    }

    function test_fundSlashAppealReserve_pullsWoodAndIncrements() public {
        uint256 regBalBefore = wood.balanceOf(address(registry));

        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.SlashAppealReserveFunded(owner, 10_000e18);
        vm.prank(owner);
        registry.fundSlashAppealReserve(10_000e18);

        assertEq(registry.slashAppealReserve(), 10_000e18);
        assertEq(wood.balanceOf(address(registry)), regBalBefore + 10_000e18);
    }

    function test_refundSlash_onlyOwner() public {
        vm.prank(owner);
        registry.fundSlashAppealReserve(10_000e18);

        vm.prank(stranger);
        vm.expectRevert();
        registry.refundSlash(recipient, 100e18);
    }

    function test_refundSlash_revertsZeroRecipient() public {
        vm.prank(owner);
        registry.fundSlashAppealReserve(10_000e18);

        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.ZeroAddress.selector);
        registry.refundSlash(address(0), 100e18);
    }

    function test_refundSlash_enforcesEpochCap() public {
        vm.prank(owner);
        registry.fundSlashAppealReserve(10_000e18);
        // Cap = 20% of 10_000e18 = 2_000e18.

        // First refund 1_500e18 — ok.
        vm.prank(owner);
        registry.refundSlash(recipient, 1_500e18);
        assertEq(registry.refundedInEpoch(registry.currentEpoch()), 1_500e18);

        // Second refund 600e18 same epoch → total 2_100e18 > 2_000e18 cap → revert.
        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.RefundCapExceeded.selector);
        registry.refundSlash(recipient, 600e18);
    }

    function test_refundSlash_capResetsNextEpoch() public {
        vm.prank(owner);
        registry.fundSlashAppealReserve(10_000e18);

        vm.prank(owner);
        registry.refundSlash(recipient, 1_500e18);
        // Remaining reserve: 8_500e18.

        // Warp to next epoch — cap resets (refundedInEpoch[nextEp] == 0).
        vm.warp(registry.epochGenesis() + registry.EPOCH_DURATION());
        uint256 nextEp = registry.currentEpoch();
        assertEq(registry.refundedInEpoch(nextEp), 0);

        // New cap = 20% of 8_500e18 = 1_700e18. Refund 600e18 fits.
        vm.prank(owner);
        registry.refundSlash(recipient, 600e18);
        assertEq(registry.refundedInEpoch(nextEp), 600e18);
    }

    function test_refundSlash_movesWood() public {
        vm.prank(owner);
        registry.fundSlashAppealReserve(10_000e18);

        uint256 recBalBefore = wood.balanceOf(recipient);

        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.SlashAppealRefunded(recipient, 500e18, registry.currentEpoch());
        vm.prank(owner);
        registry.refundSlash(recipient, 500e18);

        assertEq(wood.balanceOf(recipient), recBalBefore + 500e18);
        assertEq(registry.slashAppealReserve(), 9_500e18);
    }
}

contract GuardianRegistryPauseTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    MockGovernorMinimal governor;
    address owner = address(0xA11CE);
    address factory = address(0xFAC10);
    address alice = address(0xA11CE5);
    address stranger = address(0xBAD);

    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant PROPOSAL_ID = 1;

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        governor = new MockGovernorMinimal();

        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, address(governor), factory, address(wood), 10_000e18, 10_000e18, 7 days, REVIEW_PERIOD, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        for (uint256 i = 0; i < 5; i++) {
            address g = address(uint160(0xAA01 + i));
            wood.mint(g, 100_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
            vm.prank(g);
            registry.stakeAsGuardian(10_000e18, 1 + i);
        }

        wood.mint(alice, 100_000e18);
        vm.prank(alice);
        wood.approve(address(registry), type(uint256).max);
    }

    function _openProposal() internal returns (uint256 voteEnd_, uint256 reviewEnd_) {
        voteEnd_ = block.timestamp;
        reviewEnd_ = voteEnd_ + REVIEW_PERIOD;
        governor.setProposal(PROPOSAL_ID, voteEnd_, reviewEnd_);
        registry.openReview(PROPOSAL_ID);
    }

    function test_pause_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        registry.pause();
    }

    function test_pause_freezesVoteOnProposal() public {
        _openProposal();

        vm.prank(owner);
        registry.pause();

        address g = address(uint160(0xAA01));
        vm.prank(g);
        vm.expectRevert(IGuardianRegistry.ProtocolPaused.selector);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);
    }

    // V1.5: claimEpochReward removed. Merkl distributor has its own pause.

    function test_pause_doesNotFreezeClaimUnstake() public {
        // Guardian has staked; request unstake, pause, then claim after cooldown.
        address g = address(uint160(0xAA01));
        vm.prank(g);
        registry.requestUnstakeGuardian();

        vm.prank(owner);
        registry.pause();

        vm.warp(block.timestamp + 7 days);
        vm.prank(g);
        registry.claimUnstakeGuardian(); // must not revert
        assertEq(registry.guardianStake(g), 0);
    }

    function test_pause_doesNotFreezeStake() public {
        vm.prank(owner);
        registry.pause();

        vm.prank(alice);
        registry.stakeAsGuardian(10_000e18, 42); // must not revert
        assertEq(registry.guardianStake(alice), 10_000e18);
    }

    function test_unpause_byOwner_immediate() public {
        vm.prank(owner);
        registry.pause();
        assertTrue(registry.paused());

        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.Unpaused(owner, false);
        vm.prank(owner);
        registry.unpause();
        assertFalse(registry.paused());
        assertEq(registry.pausedAt(), 0);
    }

    function test_unpause_deadman_afterDelay() public {
        vm.prank(owner);
        registry.pause();

        vm.warp(block.timestamp + registry.DEADMAN_UNPAUSE_DELAY() + 1);

        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.Unpaused(stranger, true);
        vm.prank(stranger);
        registry.unpause();
        assertFalse(registry.paused());
    }

    function test_unpause_deadman_beforeDelay_reverts() public {
        vm.prank(owner);
        registry.pause();

        // Just before the deadman delay elapses.
        vm.warp(block.timestamp + registry.DEADMAN_UNPAUSE_DELAY() - 1);

        vm.prank(stranger);
        vm.expectRevert(IGuardianRegistry.NotPausedOrDeadmanNotElapsed.selector);
        registry.unpause();
    }
}

contract GuardianRegistryParamTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    address owner = address(0xA11CE);
    address governor = address(0x9000);
    address factory = address(0xFAC10);
    address stranger = address(0xBAD);

    // Initial values (match the initialize call below).
    uint256 constant INIT_MIN_GUARDIAN_STAKE = 10_000e18;
    uint256 constant INIT_MIN_OWNER_STAKE = 10_000e18;
    uint256 constant INIT_COOLDOWN = 7 days;
    uint256 constant INIT_REVIEW_PERIOD = 24 hours;
    uint256 constant INIT_BLOCK_QUORUM = 3000;

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (
                owner,
                governor,
                factory,
                address(wood),
                INIT_MIN_GUARDIAN_STAKE,
                INIT_MIN_OWNER_STAKE,
                INIT_COOLDOWN,
                INIT_REVIEW_PERIOD,
                INIT_BLOCK_QUORUM
            )
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));
    }

    // ── Owner-instant setters happy path ──
    function test_setMinGuardianStake_ownerInstant() public {
        uint256 target = 20_000e18;
        vm.expectEmit(true, false, false, true);
        emit IGuardianRegistry.ParameterChangeFinalized(
            registry.PARAM_MIN_GUARDIAN_STAKE(), INIT_MIN_GUARDIAN_STAKE, target
        );
        vm.prank(owner);
        registry.setMinGuardianStake(target);
        assertEq(registry.minGuardianStake(), target);
    }

    // ── Bound validation ──
    function test_setMinGuardianStake_boundsEnforced() public {
        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.InvalidParameter.selector);
        registry.setMinGuardianStake(0);
    }

    function test_setMinOwnerStake_boundsEnforced() public {
        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.InvalidParameter.selector);
        registry.setMinOwnerStake(999e18);

        // Exactly 1_000e18 should succeed.
        vm.prank(owner);
        registry.setMinOwnerStake(1_000e18);
        assertEq(registry.minOwnerStake(), 1_000e18);
    }

    function test_setCooldownPeriod_boundsEnforced() public {
        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.InvalidParameter.selector);
        registry.setCooldownPeriod(1 days - 1);

        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.InvalidParameter.selector);
        registry.setCooldownPeriod(30 days + 1);

        vm.startPrank(owner);
        registry.setCooldownPeriod(1 days);
        assertEq(registry.coolDownPeriod(), 1 days);
        registry.setCooldownPeriod(30 days);
        assertEq(registry.coolDownPeriod(), 30 days);
        vm.stopPrank();
    }

    function test_setReviewPeriod_boundsEnforced() public {
        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.InvalidParameter.selector);
        registry.setReviewPeriod(5 hours);

        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.InvalidParameter.selector);
        registry.setReviewPeriod(8 days);

        vm.startPrank(owner);
        registry.setReviewPeriod(6 hours);
        assertEq(registry.reviewPeriod(), 6 hours);
        registry.setReviewPeriod(7 days);
        assertEq(registry.reviewPeriod(), 7 days);
        vm.stopPrank();
    }

    function test_setBlockQuorumBps_boundsEnforced() public {
        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.InvalidParameter.selector);
        registry.setBlockQuorumBps(999);

        vm.prank(owner);
        vm.expectRevert(IGuardianRegistry.InvalidParameter.selector);
        registry.setBlockQuorumBps(10_001);

        vm.startPrank(owner);
        registry.setBlockQuorumBps(1_000);
        assertEq(registry.blockQuorumBps(), 1_000);
        registry.setBlockQuorumBps(10_000);
        assertEq(registry.blockQuorumBps(), 10_000);
        vm.stopPrank();
    }

    // ── Owner-only access on the other setters ──
    function test_setters_onlyOwner() public {
        vm.startPrank(stranger);
        vm.expectRevert();
        registry.setMinGuardianStake(20_000e18);
        vm.expectRevert();
        registry.setMinOwnerStake(20_000e18);
        vm.expectRevert();
        registry.setCooldownPeriod(2 days);
        vm.expectRevert();
        registry.setReviewPeriod(12 hours);
        vm.expectRevert();
        registry.setBlockQuorumBps(2_000);
        vm.stopPrank();
    }
}
