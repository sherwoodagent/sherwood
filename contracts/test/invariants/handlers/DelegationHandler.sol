// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";

import {GuardianRegistry} from "../../../src/GuardianRegistry.sol";
import {IGuardianRegistry} from "../../../src/interfaces/IGuardianRegistry.sol";
import {ERC20Mock} from "../../mocks/ERC20Mock.sol";

/// @title DelegationHandler
/// @notice Bounded fuzz-action surface for V1.5 delegation invariants
///         (INV-V1.5-1 / INV-V1.5-4 / INV-V1.5-5 / INV-V1.5-6). Drives the
///         stake + delegation + commission surfaces without attempting the
///         full governor/vote lifecycle (which is covered by targeted unit
///         tests instead).
///
///         Actor set: 4 guardians (can also be delegates) + 4 delegators.
contract DelegationHandler is Test {
    GuardianRegistry public registry;
    ERC20Mock public wood;
    address public registryOwner;

    // Actor pools — fixed membership, materialized at construction.
    address[] public guardians; // length 4
    address[] public delegators; // length 4

    constructor(GuardianRegistry _registry, ERC20Mock _wood, address _registryOwner) {
        registry = _registry;
        wood = _wood;
        registryOwner = _registryOwner;

        for (uint256 i = 0; i < 4; i++) {
            address g = makeAddr(string(abi.encodePacked("g", vm.toString(i))));
            guardians.push(g);
            wood.mint(g, 10_000_000e18);
            vm.prank(g);
            wood.approve(address(registry), type(uint256).max);
        }
        for (uint256 i = 0; i < 4; i++) {
            address d = makeAddr(string(abi.encodePacked("d", vm.toString(i))));
            delegators.push(d);
            wood.mint(d, 10_000_000e18);
            vm.prank(d);
            wood.approve(address(registry), type(uint256).max);
        }
    }

    // ── Guardian stake lifecycle ──

    function stake(uint256 actorSeed, uint256 amtSeed) external {
        address g = guardians[bound(actorSeed, 0, guardians.length - 1)];
        uint256 amt = bound(amtSeed, registry.minGuardianStake(), 1_000_000e18);
        vm.prank(g);
        try registry.stakeAsGuardian(amt, 1) {} catch {}
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

    // ── Delegation lifecycle ──

    function delegateStake(uint256 delegatorSeed, uint256 delegateSeed, uint256 amtSeed) external {
        address delegator = delegators[bound(delegatorSeed, 0, delegators.length - 1)];
        address delegate_ = guardians[bound(delegateSeed, 0, guardians.length - 1)];
        uint256 amt = bound(amtSeed, 1, 1_000_000e18);
        vm.prank(delegator);
        try registry.delegateStake(delegate_, amt) {} catch {}
    }

    function requestUnstakeDelegation(uint256 delegatorSeed, uint256 delegateSeed) external {
        address delegator = delegators[bound(delegatorSeed, 0, delegators.length - 1)];
        address delegate_ = guardians[bound(delegateSeed, 0, guardians.length - 1)];
        vm.prank(delegator);
        try registry.requestUnstakeDelegation(delegate_) {} catch {}
    }

    function cancelUnstakeDelegation(uint256 delegatorSeed, uint256 delegateSeed) external {
        address delegator = delegators[bound(delegatorSeed, 0, delegators.length - 1)];
        address delegate_ = guardians[bound(delegateSeed, 0, guardians.length - 1)];
        vm.prank(delegator);
        try registry.cancelUnstakeDelegation(delegate_) {} catch {}
    }

    function claimUnstakeDelegation(uint256 delegatorSeed, uint256 delegateSeed) external {
        address delegator = delegators[bound(delegatorSeed, 0, delegators.length - 1)];
        address delegate_ = guardians[bound(delegateSeed, 0, guardians.length - 1)];
        vm.prank(delegator);
        try registry.claimUnstakeDelegation(delegate_) {} catch {}
    }

    // ── Commission ──

    function setCommission(uint256 actorSeed, uint256 bpsSeed) external {
        address g = guardians[bound(actorSeed, 0, guardians.length - 1)];
        uint256 bps = bound(bpsSeed, 0, registry.MAX_COMMISSION_BPS());
        vm.prank(g);
        try registry.setCommission(bps) {} catch {}
    }

    // ── Time ──

    function warp(uint256 delta) external {
        delta = bound(delta, 1 hours, 7 days);
        vm.warp(block.timestamp + delta);
    }

    // ── Views ──

    function getGuardians() external view returns (address[] memory) {
        return guardians;
    }

    function getDelegators() external view returns (address[] memory) {
        return delegators;
    }
}
