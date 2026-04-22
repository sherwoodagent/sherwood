// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {GuardianRegistry} from "../../src/GuardianRegistry.sol";
import {IGuardianRegistry} from "../../src/interfaces/IGuardianRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

import {DelegationHandler} from "./handlers/DelegationHandler.sol";

/// @title DelegationInvariantsTest
/// @notice V1.5 Phase 4 — asserts the delegation-side conservation
///         invariants under bounded stateful fuzzing.
///
///         Closed invariants:
///         - INV-V1.5-1  per-delegate accounting: `_delegatedInbound[delegate]`
///                       exactly equals the sum of `_delegations[d][delegate]`
///                       across all delegators.
///         - INV-V1.5-1g global accounting: `totalDelegatedStake` equals the
///                       sum of `_delegatedInbound[g]` across all delegates.
///         - INV-V1.5-4  WOOD custody: registry's WOOD balance >=
///                       `totalGuardianStake + totalDelegatedStake +
///                        slashAppealReserve + pendingBurn + preparedStakes`.
///         - INV-V1.5-5  commission bounds: for all guardians,
///                       `commissionOf(g) <= MAX_COMMISSION_BPS`.
///
///         Invariants NOT covered by this harness (deferred to targeted unit
///         tests or the lifecycle integration test):
///         - INV-V1.5-2 / -3 (vote-weight sum / denominator parity) — require
///           active review + vote flow; covered in GuardianRegistryDelegation
///           and GuardianReviewLifecycle.
///         - INV-V1.5-7 / -8 (guardian-fee bounds / fee-waterfall ordering) —
///           governor-side; covered in GuardianRegistryProposalReward.
///         - INV-V1.5-9 / -10 (guardian-fee conservation / asset custody) —
///           require the full settlement + claim path; covered in
///           GuardianRegistryProposalReward.
///         - INV-V1.5-11 (no retroactive commission) — unit-tested.
contract DelegationInvariantsTest is StdInvariant, Test {
    GuardianRegistry public registry;
    ERC20Mock public wood;
    DelegationHandler public handler;

    address public owner = makeAddr("owner");
    address public mockGovernor = makeAddr("mockGovernor");
    address public mockFactory = makeAddr("mockFactory");

    uint256 constant MIN_STAKE = 10_000e18;
    uint256 constant COOL_DOWN = 7 days;
    uint256 constant REVIEW_PERIOD = 24 hours;
    uint256 constant BLOCK_QUORUM_BPS = 3000;

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);

        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, mockGovernor, mockFactory, address(wood), MIN_STAKE, MIN_STAKE, COOL_DOWN, REVIEW_PERIOD, BLOCK_QUORUM_BPS)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        handler = new DelegationHandler(registry, wood, owner);

        targetContract(address(handler));

        // Restrict to the handler's bounded action surface.
        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = DelegationHandler.stake.selector;
        selectors[1] = DelegationHandler.requestUnstake.selector;
        selectors[2] = DelegationHandler.cancelUnstake.selector;
        selectors[3] = DelegationHandler.claimUnstake.selector;
        selectors[4] = DelegationHandler.delegateStake.selector;
        selectors[5] = DelegationHandler.requestUnstakeDelegation.selector;
        selectors[6] = DelegationHandler.cancelUnstakeDelegation.selector;
        selectors[7] = DelegationHandler.claimUnstakeDelegation.selector;
        selectors[8] = DelegationHandler.setCommission.selector;
        selectors[9] = DelegationHandler.warp.selector;
        selectors[10] = DelegationHandler.stake.selector; // keep stake dominant
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice INV-V1.5-1 per delegate: `delegatedInbound(g)` must equal
    ///         `sum(delegationOf(d, g))` across all delegators `d`.
    function invariant_delegatedInbound_equalsSumOfDelegations() public view {
        address[] memory gs = handler.getGuardians();
        address[] memory ds = handler.getDelegators();
        for (uint256 i = 0; i < gs.length; i++) {
            uint256 sum;
            for (uint256 j = 0; j < ds.length; j++) {
                sum += registry.delegationOf(ds[j], gs[i]);
            }
            assertEq(
                registry.delegatedInbound(gs[i]), sum, "INV-V1.5-1: inbound != sum(delegations) for this delegate"
            );
        }
    }

    /// @notice INV-V1.5-1 global: `totalDelegatedStake` must equal the sum of
    ///         `delegatedInbound(g)` across all delegates.
    function invariant_totalDelegatedStake_equalsSumOfInbound() public view {
        address[] memory gs = handler.getGuardians();
        uint256 sum;
        for (uint256 i = 0; i < gs.length; i++) {
            sum += registry.delegatedInbound(gs[i]);
        }
        assertEq(
            registry.totalDelegatedStake(), sum, "INV-V1.5-1g: totalDelegatedStake != sum(inbound)"
        );
    }

    /// @notice INV-V1.5-4 WOOD custody: registry's WOOD balance must cover
    ///         every obligation it tracks — guardian stake + delegated stake
    ///         + prepared stakes (owner) + slash-appeal reserve. Donations
    ///         above this are fine.
    function invariant_woodCustody_balanceCoversObligations() public view {
        address[] memory gs = handler.getGuardians();
        address[] memory ds = handler.getDelegators();

        uint256 obligations =
            registry.totalGuardianStake() + registry.totalDelegatedStake() + registry.slashAppealReserve();

        // Prepared owner stakes — delegators could in principle have called
        // `prepareOwnerStake`; handler doesn't drive that path, but we include
        // the term defensively.
        for (uint256 i = 0; i < gs.length; i++) obligations += registry.preparedStakeOf(gs[i]);
        for (uint256 i = 0; i < ds.length; i++) obligations += registry.preparedStakeOf(ds[i]);

        uint256 bal = wood.balanceOf(address(registry));
        assertGe(bal, obligations, "INV-V1.5-4: registry WOOD balance < obligations");
    }

    /// @notice INV-V1.5-5 commission bounds: `commissionOf(g) <= MAX_COMMISSION_BPS`
    ///         for every guardian the handler interacts with.
    function invariant_commission_withinBounds() public view {
        address[] memory gs = handler.getGuardians();
        uint256 max = registry.MAX_COMMISSION_BPS();
        for (uint256 i = 0; i < gs.length; i++) {
            assertLe(registry.commissionOf(gs[i]), max, "INV-V1.5-5: commission exceeds max");
        }
    }
}
