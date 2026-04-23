// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";
import {GuardianRegistry} from "../src/GuardianRegistry.sol";
import {IGuardianRegistry} from "../src/interfaces/IGuardianRegistry.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {BlacklistingERC20Mock} from "./mocks/BlacklistingERC20Mock.sol";
import {MockGovernorMinimal} from "./mocks/MockGovernorMinimal.sol";

/// @title GuardianRegistryProposalReward — V1.5 Phase 3 Tasks 3.7/3.8/3.9
/// @notice Covers the on-chain guardian-fee claim flow: fundProposalGuardianPool,
///         claimProposalReward (approver + DPoS commission), W-1 escrow,
///         flushUnclaimedApproverFee, and cross-proposal drain regression.
contract GuardianRegistryProposalRewardTest is Test {
    GuardianRegistry registry;
    ERC20Mock wood;
    BlacklistingERC20Mock usdc;
    MockGovernorMinimal mockGov;

    address owner = makeAddr("owner");
    address factory = makeAddr("factory");
    address approver = makeAddr("approver");
    address approver2 = makeAddr("approver2");
    address blocker = makeAddr("blocker");
    address delegator1 = makeAddr("delegator1");
    address delegator2 = makeAddr("delegator2");

    uint256 constant COOL_DOWN = 7 days;
    uint256 constant MIN_STAKE = 10_000e18;
    uint256 constant FEE_AMOUNT = 1_000e6; // 1k USDC guardian fee
    uint256 constant PID = 42;

    function setUp() public {
        wood = new ERC20Mock("WOOD", "WOOD", 18);
        usdc = new BlacklistingERC20Mock("USD Coin", "USDC", 6);
        mockGov = new MockGovernorMinimal();

        GuardianRegistry impl = new GuardianRegistry();
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (owner, address(mockGov), factory, address(wood), MIN_STAKE, MIN_STAKE, COOL_DOWN, 24 hours, 3000)
        );
        registry = GuardianRegistry(address(new ERC1967Proxy(address(impl), initData)));

        // Ensure cohort-at-open meets MIN_COHORT_STAKE_AT_OPEN (50k) so openReview
        // actually records weights rather than short-circuiting.
        _stake(approver, 20_000e18, 1);
        _stake(approver2, 20_000e18, 2);
        _stake(blocker, 20_000e18, 3);

        // Delegators have WOOD approved but don't stake themselves.
        wood.mint(delegator1, 1_000_000e18);
        wood.mint(delegator2, 1_000_000e18);
        vm.prank(delegator1);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(delegator2);
        wood.approve(address(registry), type(uint256).max);

        // Pre-fund the registry with USDC (simulates governor's
        // transferPerformanceFee step).
        usdc.mint(address(registry), 10 * FEE_AMOUNT);
    }

    function _stake(address g, uint256 amt, uint256 agentId) internal {
        wood.mint(g, amt);
        vm.prank(g);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(g);
        registry.stakeAsGuardian(amt, agentId);
    }

    /// @dev Opens a review, has `approverA` and optionally `approverB` vote
    ///      Approve, and `blk` vote Block. Then warps past reviewEnd and
    ///      resolves. Returns after resolveReview so settlement can happen.
    function _runReview(address approverA, address approverB, address blk) internal {
        // Set up proposal in mock governor.
        uint256 voteEnd = vm.getBlockTimestamp() + 1;
        uint256 reviewEnd = voteEnd + 24 hours + 1;
        mockGov.setProposal(PID, voteEnd, reviewEnd);

        vm.warp(voteEnd); // now == voteEnd
        registry.openReview(PID);

        // Advance so block.timestamp >= voteEnd AND < reviewEnd for voting.
        vm.warp(voteEnd + 1);

        vm.prank(approverA);
        registry.voteOnProposal(PID, IGuardianRegistry.GuardianVoteType.Approve);

        if (approverB != address(0)) {
            vm.prank(approverB);
            registry.voteOnProposal(PID, IGuardianRegistry.GuardianVoteType.Approve);
        }

        if (blk != address(0)) {
            vm.prank(blk);
            registry.voteOnProposal(PID, IGuardianRegistry.GuardianVoteType.Block);
        }

        vm.warp(reviewEnd);
        registry.resolveReview(PID);
    }

    function _fundPool() internal {
        vm.prank(address(mockGov));
        registry.fundProposalGuardianPool(PID, address(usdc), FEE_AMOUNT);
    }

    // ── Single-approver claim path ──

    /// @notice Solo approver with no delegators receives their FULL gross share
    ///         regardless of commission rate (C-1 fix — see PR #242 review).
    ///         Commission only applies to the delegated portion; with 0
    ///         delegators, grossFromDelegated = 0 so commission = 0.
    function test_claim_singleApprover_noCommission_allToApprover() public {
        _runReview(approver, address(0), address(0));
        _fundPool();

        uint256 before = usdc.balanceOf(approver);
        vm.prank(approver);
        registry.claimProposalReward(PID);
        // Full FEE_AMOUNT — solo approver, no delegators.
        assertEq(usdc.balanceOf(approver) - before, FEE_AMOUNT);
    }

    /// @notice Regression for I-A (PR #242 re-review): solo approver who
    ///         requests unstake mid-review still gets their full gross share.
    ///         The own-stake weight lookup at `r.openedAt` (not `settledAt`)
    ///         means a mid-review unstake — which pushes `_stakeCheckpoints=0`
    ///         at requestUnstake time — does not corrupt the attribution.
    function test_claim_soloApprover_unstakesMidReview_stillGetsFullShare() public {
        vm.prank(approver);
        registry.setCommission(2000); // would otherwise strand remainder

        // Open + vote Approve (freezes w at openedAt).
        uint256 voteEnd = vm.getBlockTimestamp() + 1;
        uint256 reviewEnd = voteEnd + 24 hours + 1;
        mockGov.setProposal(PID, voteEnd, reviewEnd);
        vm.warp(voteEnd);
        registry.openReview(PID);
        vm.warp(voteEnd + 1);
        vm.prank(approver);
        registry.voteOnProposal(PID, IGuardianRegistry.GuardianVoteType.Approve);

        // Approver requests unstake mid-review (_stakeCheckpoints[approver]
        // gets pushed 0 at this moment).
        vm.prank(approver);
        registry.requestUnstakeGuardian();

        // Review resolves (not blocked).
        vm.warp(reviewEnd);
        registry.resolveReview(PID);
        _fundPool();

        uint256 before = usdc.balanceOf(approver);
        vm.prank(approver);
        registry.claimProposalReward(PID);
        // Full FEE_AMOUNT — grossFromOwn reads stake at openedAt (before the
        // mid-review unstake), not at settledAt.
        assertEq(usdc.balanceOf(approver) - before, FEE_AMOUNT);
    }

    /// @notice Solo approver with 20% commission still gets FULL gross share
    ///         — commission rate is moot when grossFromDelegated = 0 (C-1 fix).
    function test_claim_soloApprover_withCommission_getsFullShare() public {
        vm.prank(approver);
        registry.setCommission(2000); // 20%
        _runReview(approver, address(0), address(0));
        _fundPool();

        uint256 before = usdc.balanceOf(approver);
        vm.prank(approver);
        registry.claimProposalReward(PID);
        assertEq(usdc.balanceOf(approver) - before, FEE_AMOUNT, "solo approver gets full share");
    }

    function test_claim_twoApprovers_equalWeight_halfEach() public {
        // Both approvers set 0 commission; solo (no delegators) → each gets
        // their full 50% share = 500 USDC regardless of rate.
        vm.prank(approver);
        registry.setCommission(2000);
        vm.prank(approver2);
        registry.setCommission(2000);
        _runReview(approver, approver2, address(0));
        _fundPool();

        vm.prank(approver);
        registry.claimProposalReward(PID);
        vm.prank(approver2);
        registry.claimProposalReward(PID);
        // Each: gross = 500, ownW=w → grossFromOwn=500, grossFromDelegated=0,
        // commission=0, approverPayout=500.
        assertEq(usdc.balanceOf(approver), 500e6);
        assertEq(usdc.balanceOf(approver2), 500e6);
    }

    // ── Approver restriction ──

    function test_claim_blocker_reverts() public {
        _runReview(approver, address(0), blocker);
        _fundPool();
        vm.expectRevert(IGuardianRegistry.NotApprover.selector);
        vm.prank(blocker);
        registry.claimProposalReward(PID);
    }

    function test_claim_nonVoter_reverts() public {
        _runReview(approver, address(0), address(0));
        _fundPool();
        vm.expectRevert(IGuardianRegistry.NotApprover.selector);
        vm.prank(delegator1);
        registry.claimProposalReward(PID);
    }

    function test_claim_noPool_reverts() public {
        _runReview(approver, address(0), address(0));
        vm.expectRevert(IGuardianRegistry.NoPoolFunded.selector);
        vm.prank(approver);
        registry.claimProposalReward(PID);
    }

    function test_claim_double_reverts() public {
        _runReview(approver, address(0), address(0));
        _fundPool();
        vm.prank(approver);
        registry.claimProposalReward(PID);
        vm.expectRevert(IGuardianRegistry.AlreadyClaimed.selector);
        vm.prank(approver);
        registry.claimProposalReward(PID);
    }

    // ── Commission-at-settledAt (INV-V1.5-11) ──

    /// @notice Commission rate applied is the rate at settledAt, not claim
    ///         time (INV-V1.5-11). Needs a delegator to observe the
    ///         commission semantics — a solo approver is insensitive to the
    ///         rate (C-1 fix).
    function test_claim_commissionFrozenAtSettledAt() public {
        // Delegator delegates 20k to approver (matches own-stake 1:1 for clean
        // math: grossFromOwn = 500, grossFromDelegated = 500, 10% commission
        // on delegated = 50 → approverPayout = 550).
        vm.prank(approver);
        registry.setCommission(1000); // 10%
        wood.mint(delegator1, 20_000e18);
        vm.prank(delegator1);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(delegator1);
        registry.delegateStake(approver, 20_000e18);
        vm.warp(vm.getBlockTimestamp() + 1);

        _runReview(approver, address(0), address(0));
        _fundPool(); // stamps settledAt

        // Raise commission AFTER settlement — should not affect this claim.
        vm.warp(vm.getBlockTimestamp() + 7 days);
        vm.prank(approver);
        registry.setCommission(1500);

        vm.prank(approver);
        registry.claimProposalReward(PID);
        // own 20k + delegated 20k = 40k vote weight.
        // gross = 1000, grossFromOwn = 500, grossFromDelegated = 500.
        // 10% rate frozen at settledAt: commission = 50, approverPayout = 550.
        assertEq(usdc.balanceOf(approver), 550e6, "own 500 + 10% of delegated 500 = 550");
    }

    // ── Delegator claim ──

    /// @notice Clean 20k own + 20k delegated (10k + 10k), 20% commission.
    ///         C-1 fix: grossFromOwn = 500 (to approver), grossFromDelegated =
    ///         500, commission = 100 (to approver), remainder = 400 split 50/50.
    function test_claimDelegator_splitsProRata() public {
        vm.prank(approver);
        registry.setCommission(2000);
        wood.mint(delegator1, 10_000e18);
        wood.mint(delegator2, 10_000e18);
        vm.prank(delegator1);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(delegator2);
        wood.approve(address(registry), type(uint256).max);
        vm.prank(delegator1);
        registry.delegateStake(approver, 10_000e18);
        vm.prank(delegator2);
        registry.delegateStake(approver, 10_000e18);
        vm.warp(vm.getBlockTimestamp() + 1);

        _runReview(approver, address(0), address(0));
        _fundPool();

        uint256 aBefore = usdc.balanceOf(approver);
        vm.prank(approver);
        registry.claimProposalReward(PID);
        // own 20k + delegated 20k = 40k. gross=1000, fromOwn=500, fromDeleg=500,
        // commission=100, payout=600, remainder=400.
        assertEq(usdc.balanceOf(approver) - aBefore, 600e6);

        vm.prank(delegator1);
        registry.claimDelegatorProposalReward(approver, PID);
        assertEq(usdc.balanceOf(delegator1), 200e6, "50% * 400 = 200");

        vm.prank(delegator2);
        registry.claimDelegatorProposalReward(approver, PID);
        assertEq(usdc.balanceOf(delegator2), 200e6, "50% * 400 = 200");
    }

    function test_claimDelegator_beforeApproverClaim_reverts() public {
        vm.prank(delegator1);
        registry.delegateStake(approver, 500e18);
        vm.warp(vm.getBlockTimestamp() + 1);

        _runReview(approver, address(0), address(0));
        _fundPool();

        vm.expectRevert(IGuardianRegistry.DelegatePoolEmpty.selector);
        vm.prank(delegator1);
        registry.claimDelegatorProposalReward(approver, PID);
    }

    function test_claimDelegator_double_reverts() public {
        vm.prank(approver);
        registry.setCommission(2000);
        vm.prank(delegator1);
        registry.delegateStake(approver, 1_000e18);
        vm.warp(vm.getBlockTimestamp() + 1);

        _runReview(approver, address(0), address(0));
        _fundPool();
        vm.prank(approver);
        registry.claimProposalReward(PID);
        vm.prank(delegator1);
        registry.claimDelegatorProposalReward(approver, PID);

        vm.expectRevert(IGuardianRegistry.AlreadyClaimed.selector);
        vm.prank(delegator1);
        registry.claimDelegatorProposalReward(approver, PID);
    }

    // ── W-1 escrow ──

    function test_claim_blacklistedApprover_escrows() public {
        // Solo approver, 20% commission (moot — no delegators). Full 1000 USDC
        // escrowed when blacklisted.
        vm.prank(approver);
        registry.setCommission(2000);
        _runReview(approver, address(0), address(0));
        _fundPool();
        usdc.setBlacklisted(approver, true);

        vm.expectEmit(true, true, true, true);
        emit IGuardianRegistry.ApproverFeeEscrowed(PID, approver, address(usdc), FEE_AMOUNT);
        vm.prank(approver);
        registry.claimProposalReward(PID);

        assertEq(registry.unclaimedApproverFees(keccak256(abi.encode(PID, approver, address(usdc)))), FEE_AMOUNT);
    }

    function test_flushUnclaimedApproverFee_retriesAfterUnblacklist() public {
        vm.prank(approver);
        registry.setCommission(2000);
        _runReview(approver, address(0), address(0));
        _fundPool();
        usdc.setBlacklisted(approver, true);
        vm.prank(approver);
        registry.claimProposalReward(PID);

        usdc.setBlacklisted(approver, false);
        uint256 before = usdc.balanceOf(approver);
        registry.flushUnclaimedApproverFee(PID, approver, address(usdc));
        assertEq(usdc.balanceOf(approver) - before, FEE_AMOUNT);
        assertEq(registry.unclaimedApproverFees(keccak256(abi.encode(PID, approver, address(usdc)))), 0);
    }

    function test_flushUnclaimedApproverFee_noEscrow_reverts() public {
        vm.expectRevert(IGuardianRegistry.NoEscrowedAmount.selector);
        registry.flushUnclaimedApproverFee(PID, approver, address(usdc));
    }

    // ── Cross-proposal drain regression (PR #229 review finding class) ──

    function test_flush_cannotDrainUnrelatedProposal() public {
        vm.prank(approver);
        registry.setCommission(2000);
        _runReview(approver, address(0), address(0));
        _fundPool();
        usdc.setBlacklisted(approver, true);
        vm.prank(approver);
        registry.claimProposalReward(PID);
        usdc.setBlacklisted(approver, false);

        // Attempt flush with wrong proposalId → no match in keyed mapping.
        vm.expectRevert(IGuardianRegistry.NoEscrowedAmount.selector);
        registry.flushUnclaimedApproverFee(9999, approver, address(usdc));

        // Original escrow still intact.
        assertEq(registry.unclaimedApproverFees(keccak256(abi.encode(PID, approver, address(usdc)))), FEE_AMOUNT);
    }
}
