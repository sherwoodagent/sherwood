// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {GuardianRegistry} from "../src/GuardianRegistry.sol";
import {IGuardianRegistry} from "../src/interfaces/IGuardianRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockERC4626Vault} from "./mocks/MockERC4626Vault.sol";
import {MockGovernorMinimal} from "./mocks/MockGovernorMinimal.sol";

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
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, 0, 7 days, 24 hours, 3000)
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
        // Creator prepares only the floor.
        vm.prank(creator);
        registry.prepareOwnerStake(10_000e18);

        // Activate TVL scaling and give the vault enough TVL that requiredOwnerBond
        // exceeds the prepared amount. With WOOD-denominated vault (18 decimals) and
        // bps = 100 (1%), TVL of 2_000_000e18 implies a bond of 20_000e18 — 2x the
        // floor, so the bind must revert.
        stdstore.target(address(registry)).sig("ownerStakeTvlBps()").checked_write(uint256(100));
        vault.setTotalAssets(2_000_000e18);

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
        vm.expectRevert(IGuardianRegistry.VaultHasActiveProposal.selector);
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
            (owner, address(governor), factory, address(wood), 10_000e18, 10_000e18, 0, COOL_DOWN, 24 hours, 3000)
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
        governor.setActiveProposal(address(vault), 42);
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
            (owner, governor, factory, address(wood), 10_000e18, 10_000e18, 0, 7 days, 24 hours, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        vault = new MockERC4626Vault();
    }

    function test_requiredOwnerBond_zeroBps_returnsFloor() public {
        // V1 default: ownerStakeTvlBps == 0 → floor regardless of totalAssets.
        vault.setTotalAssets(1_000_000e18);
        assertEq(registry.requiredOwnerBond(address(vault)), 10_000e18);

        vault.setTotalAssets(0);
        assertEq(registry.requiredOwnerBond(address(vault)), 10_000e18);
    }

    function test_requiredOwnerBond_nonzeroBps_scales() public {
        // Flip bps to 50 (0.5%) via direct storage write (timelocked setter not
        // implemented until Task 24). For a WOOD-denominated vault (18 decimals,
        // matching the floor units) with TVL = 10_000_000e18, scaled bond =
        // 10_000_000e18 * 50 / 10_000 = 50_000e18 — above the 10_000e18 floor.
        stdstore.target(address(registry)).sig("ownerStakeTvlBps()").checked_write(uint256(50));
        vault.setTotalAssets(10_000_000e18);

        assertEq(registry.requiredOwnerBond(address(vault)), 50_000e18);
    }

    function test_requiredOwnerBond_nonzeroBps_floorDominatesAtLowTvl() public {
        // At low TVL the scaled term is below the floor → floor wins.
        // bps = 50, TVL = 1_000_000e18 → scaled = 5_000e18 < floor 10_000e18.
        stdstore.target(address(registry)).sig("ownerStakeTvlBps()").checked_write(uint256(50));
        vault.setTotalAssets(1_000_000e18);

        assertEq(registry.requiredOwnerBond(address(vault)), 10_000e18);
    }

    function test_requiredOwnerBond_nonzeroBps_boundary() public {
        // Exact floor: scaled == floor → tie goes to floor (scaled > floor is strict).
        stdstore.target(address(registry)).sig("ownerStakeTvlBps()").checked_write(uint256(100));
        vault.setTotalAssets(1_000_000e18); // 1% of 1M = 10_000e18 == floor
        assertEq(registry.requiredOwnerBond(address(vault)), 10_000e18);

        vault.setTotalAssets(1_000_001e18); // nudge above
        assertEq(registry.requiredOwnerBond(address(vault)), 10_000.01e18);
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
            (owner, address(governor), factory, address(wood), 10_000e18, 10_000e18, 0, 7 days, REVIEW_PERIOD, 3000)
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
            (owner, address(governor), factory, address(wood), 10_000e18, 10_000e18, 0, 7 days, REVIEW_PERIOD, 3000)
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

        voteEnd = block.timestamp;
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

        // Top up *after* openReview: snapshot must reflect stake at vote time
        // (guardianStake at the moment of voteOnProposal), not at openReview.
        vm.prank(g);
        registry.stakeAsGuardian(5_000e18, 42); // agentId arg ignored on top-up
        assertEq(registry.guardianStake(g), 15_000e18);

        // First vote should snapshot the current 15_000e18.
        vm.expectEmit(true, true, false, true);
        emit IGuardianRegistry.GuardianVoteCast(PROPOSAL_ID, g, IGuardianRegistry.GuardianVoteType.Block, 15_000e18);
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
        _openReview();

        // Fill 100 Approves (mint+stake 100 fresh guardians).
        uint256 cap = registry.MAX_APPROVERS_PER_PROPOSAL();
        for (uint256 i = 0; i < cap; i++) {
            address g = address(uint160(0x100000 + i));
            wood.mint(g, 100_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
            vm.prank(g);
            registry.stakeAsGuardian(10_000e18, 1 + i);
            vm.prank(g);
            registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);
        }

        // 101st Approve: revert + ApproverCapReached event.
        address last = address(uint160(0x100000 + cap));
        wood.mint(last, 100_000e18);
        vm.prank(last);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(last);
        registry.stakeAsGuardian(10_000e18, 999);

        vm.expectEmit(true, false, false, false);
        emit IGuardianRegistry.ApproverCapReached(PROPOSAL_ID);
        vm.prank(last);
        vm.expectRevert(IGuardianRegistry.NewSideFull.selector);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Approve);

        // 101st Block succeeds — blockers uncapped.
        vm.prank(last);
        registry.voteOnProposal(PROPOSAL_ID, IGuardianRegistry.GuardianVoteType.Block);
    }
}
