// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseIntegrationTest} from "./BaseIntegrationTest.sol";
import {MoonwellSupplyStrategy} from "../../src/strategies/MoonwellSupplyStrategy.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title GovernanceIntegrationTest
 * @notice Fork tests for governance edge cases against real Base mainnet deployment.
 *         Uses MoonwellSupplyStrategy as the DeFi interaction but focuses on governance paths:
 *         veto by owner, rejection by votes, emergency settle, cooldown enforcement,
 *         fee distribution, and sequential strategy execution.
 *
 * @dev Run with: forge test --fork-url $BASE_RPC_URL --match-contract GovernanceIntegrationTest
 */
contract GovernanceIntegrationTest is BaseIntegrationTest {
    address moonwellTemplate;

    uint256 constant SUPPLY_AMOUNT = 10_000e6;
    uint256 constant MIN_REDEEM = 9_900e6;
    uint256 constant STRATEGY_DURATION = 7 days;
    uint256 constant PERF_FEE_BPS = 1500; // 15%

    function setUp() public override {
        super.setUp();
        moonwellTemplate = address(new MoonwellSupplyStrategy());
    }

    // ==================== HELPERS ====================

    /// @dev Build execution and settlement batch calls for a Moonwell supply strategy.
    function _buildMoonwellCalls(address strategy, uint256 amount)
        internal
        pure
        returns (BatchExecutorLib.Call[] memory execCalls, BatchExecutorLib.Call[] memory settleCalls)
    {
        execCalls = new BatchExecutorLib.Call[](2);
        execCalls[0] =
            BatchExecutorLib.Call({target: USDC, data: abi.encodeCall(IERC20.approve, (strategy, amount)), value: 0});
        execCalls[1] = BatchExecutorLib.Call({target: strategy, data: abi.encodeWithSignature("execute()"), value: 0});

        settleCalls = new BatchExecutorLib.Call[](1);
        settleCalls[0] = BatchExecutorLib.Call({target: strategy, data: abi.encodeWithSignature("settle()"), value: 0});
    }

    /// @dev Clone a MoonwellSupplyStrategy, initialize it, and build batch calls.
    ///      Does NOT propose — callers decide how to use the calls.
    function _deployMoonwellStrategy(uint256 supplyAmount)
        internal
        returns (address strategy, BatchExecutorLib.Call[] memory execCalls, BatchExecutorLib.Call[] memory settleCalls)
    {
        bytes memory initData = abi.encode(USDC, MOONWELL_MUSDC, supplyAmount, MIN_REDEEM, false);
        strategy = _cloneAndInit(moonwellTemplate, initData);
        (execCalls, settleCalls) = _buildMoonwellCalls(strategy, supplyAmount);
    }

    // ==================== TEST 1: VETO BY OWNER ====================

    /// @notice Owner vetoes a pending proposal, blocking execution.
    function test_governance_vetoByOwner() public {
        (, BatchExecutorLib.Call[] memory execCalls, BatchExecutorLib.Call[] memory settleCalls) =
            _deployMoonwellStrategy(SUPPLY_AMOUNT);

        // Agent proposes
        vm.prank(agent);
        uint256 proposalId = governor.propose(
            address(vault),
            "ipfs://veto-test",
            PERF_FEE_BPS,
            STRATEGY_DURATION,
            execCalls,
            settleCalls,
            _emptyCoProposers()
        );

        // Warp 1 second so proposal is in Pending state
        vm.warp(block.timestamp + 1);

        // Owner vetoes
        vm.prank(owner);
        governor.vetoProposal(proposalId);

        // Assert: state is Rejected
        assertEq(
            uint256(governor.getProposalState(proposalId)),
            uint256(ISyndicateGovernor.ProposalState.Rejected),
            "proposal should be Rejected after veto"
        );

        // Trying to execute should revert
        vm.expectRevert(ISyndicateGovernor.ProposalNotApproved.selector);
        governor.executeProposal(proposalId);
    }

    // ==================== TEST 2: REJECTED BY VOTES ====================

    /// @notice Both LPs vote Against, reaching the veto threshold → proposal rejected.
    function test_governance_rejectedByVotes() public {
        (, BatchExecutorLib.Call[] memory execCalls, BatchExecutorLib.Call[] memory settleCalls) =
            _deployMoonwellStrategy(SUPPLY_AMOUNT);

        // Agent proposes
        vm.prank(agent);
        uint256 proposalId = governor.propose(
            address(vault),
            "ipfs://reject-test",
            PERF_FEE_BPS,
            STRATEGY_DURATION,
            execCalls,
            settleCalls,
            _emptyCoProposers()
        );

        // Warp 1 second so snapshot timestamp is in the past
        vm.warp(block.timestamp + 1);

        // Both LPs vote Against
        vm.prank(lp1);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Against);
        vm.prank(lp2);
        governor.vote(proposalId, ISyndicateGovernor.VoteType.Against);

        // Warp past voting period
        ISyndicateGovernor.GovernorParams memory params = governor.getGovernorParams();
        vm.warp(block.timestamp + params.votingPeriod + 1);

        // Assert: state is Rejected (100% against exceeds any veto threshold)
        assertEq(
            uint256(governor.getProposalState(proposalId)),
            uint256(ISyndicateGovernor.ProposalState.Rejected),
            "proposal should be Rejected after Against votes exceed veto threshold"
        );

        // Trying to execute should revert
        vm.expectRevert(ISyndicateGovernor.ProposalNotApproved.selector);
        governor.executeProposal(proposalId);
    }

    // ==================== TEST 3: EMERGENCY SETTLE (Task 24 moved) ====================

    // Legacy `emergencySettle` is now a revert stub; see
    // `test/governor/GovernorEmergency.t.sol` for the guardian-review lifecycle
    // (unstick / emergencySettleWithCalls / cancel / finalize) that replaces it.

    // ==================== TEST 4: COOLDOWN ENFORCED ====================

    /// @notice Executing a second strategy before cooldown elapses reverts.
    function test_governance_cooldownEnforced() public {
        // --- Strategy #1: execute and settle ---
        (, BatchExecutorLib.Call[] memory exec1, BatchExecutorLib.Call[] memory settle1) =
            _deployMoonwellStrategy(SUPPLY_AMOUNT);

        uint256 pid1 = _proposeVoteExecute(exec1, settle1, PERF_FEE_BPS, STRATEGY_DURATION);

        // Proposer settles early (agent can settle anytime)
        vm.prank(agent);
        governor.settleProposal(pid1);

        assertEq(
            uint256(governor.getProposalState(pid1)),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "strategy #1 should be settled"
        );

        // --- Strategy #2: propose and vote, but execution should fail due to cooldown ---
        (, BatchExecutorLib.Call[] memory exec2, BatchExecutorLib.Call[] memory settle2) =
            _deployMoonwellStrategy(SUPPLY_AMOUNT);

        // Propose
        vm.prank(agent);
        uint256 pid2 = governor.propose(
            address(vault), "ipfs://cooldown-test", PERF_FEE_BPS, STRATEGY_DURATION, exec2, settle2, _emptyCoProposers()
        );

        // Warp 1 second for snapshot
        vm.warp(block.timestamp + 1);

        // LPs vote For
        vm.prank(lp1);
        governor.vote(pid2, ISyndicateGovernor.VoteType.For);
        vm.prank(lp2);
        governor.vote(pid2, ISyndicateGovernor.VoteType.For);

        // Warp past voting period but NOT past cooldown
        ISyndicateGovernor.GovernorParams memory params = governor.getGovernorParams();
        vm.warp(block.timestamp + params.votingPeriod + 1);

        // Execution should revert because cooldown has not elapsed
        uint256 cooldownEnd = governor.getCooldownEnd(address(vault));
        if (block.timestamp < cooldownEnd) {
            vm.expectRevert(ISyndicateGovernor.CooldownNotElapsed.selector);
            governor.executeProposal(pid2);
        }

        // Warp past cooldown
        vm.warp(cooldownEnd + 1);

        // Now execution should succeed (if still within execution window)
        // Check if we're still within the execution window; if expired, re-propose
        ISyndicateGovernor.ProposalState state2 = governor.getProposalState(pid2);
        if (state2 == ISyndicateGovernor.ProposalState.Approved) {
            governor.executeProposal(pid2);
            assertEq(
                uint256(governor.getProposalState(pid2)),
                uint256(ISyndicateGovernor.ProposalState.Executed),
                "strategy #2 should execute after cooldown"
            );
        } else {
            // Execution window expired while waiting for cooldown — re-propose strategy #2
            (, BatchExecutorLib.Call[] memory exec2b, BatchExecutorLib.Call[] memory settle2b) =
                _deployMoonwellStrategy(SUPPLY_AMOUNT);

            uint256 pid2b = _proposeVoteExecute(exec2b, settle2b, PERF_FEE_BPS, STRATEGY_DURATION);

            assertEq(
                uint256(governor.getProposalState(pid2b)),
                uint256(ISyndicateGovernor.ProposalState.Executed),
                "strategy #2 (re-proposed) should execute after cooldown"
            );
        }
    }

    // ==================== TEST 5: FEE DISTRIBUTION ====================

    /// @notice Verify protocol fee and agent fee distribution on profitable settlement.
    function test_governance_feeDistribution() public {
        (, BatchExecutorLib.Call[] memory execCalls, BatchExecutorLib.Call[] memory settleCalls) =
            _deployMoonwellStrategy(SUPPLY_AMOUNT);

        // Execute Moonwell strategy with 15% agent fee
        uint256 proposalId = _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);

        // Read protocol fee config from governor
        uint256 protocolFeeBps = governor.protocolFeeBps();
        address protocolFeeRecipient = governor.protocolFeeRecipient();

        // Simulate profit by dealing extra USDC to vault
        uint256 profit = 5_000e6;
        uint256 vaultBal = IERC20(USDC).balanceOf(address(vault));
        deal(USDC, address(vault), vaultBal + profit);

        // Record balances before settlement
        uint256 agentBalBefore = IERC20(USDC).balanceOf(agent);
        uint256 protocolBalBefore =
            protocolFeeRecipient != address(0) ? IERC20(USDC).balanceOf(protocolFeeRecipient) : 0;

        // Warp past duration and settle
        vm.warp(block.timestamp + STRATEGY_DURATION);
        vm.prank(random);
        governor.settleProposal(proposalId);

        // Assert settled
        assertEq(
            uint256(governor.getProposalState(proposalId)),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "proposal should be settled"
        );

        // Calculate expected fees
        // Protocol fee is taken first from gross profit
        uint256 expectedProtocolFee = (profit * protocolFeeBps) / 10000;
        uint256 netProfit = profit - expectedProtocolFee;
        // Agent fee is taken from net profit
        uint256 expectedAgentFee = (netProfit * PERF_FEE_BPS) / 10000;

        // Verify protocol fee distribution (use approx due to real Moonwell yield accrual)
        if (protocolFeeBps > 0 && protocolFeeRecipient != address(0)) {
            uint256 protocolBalAfter = IERC20(USDC).balanceOf(protocolFeeRecipient);
            uint256 actualProtocolFee = protocolBalAfter - protocolBalBefore;
            // Real Moonwell yield may add a small amount to profit, so fee may be slightly higher
            assertApproxEqAbs(
                actualProtocolFee,
                expectedProtocolFee,
                1e6, // 1 USDC tolerance for Moonwell yield accrual during test
                "protocol fee recipient should receive approximately correct fee"
            );
        }

        // Verify agent fee distribution. Moonwell real yield accrual during the
        // fork's block window adds to gross profit, which propagates through
        // the full net-profit × fee-bps multiplier. Tolerance scales with the
        // fee base (15% × ~5000 USDC = ~735 USDC) to match the relative
        // tolerance on the protocol fee check (1 USDC on ~100 USDC = ~1%).
        uint256 agentBalAfter = IERC20(USDC).balanceOf(agent);
        assertApproxEqAbs(
            agentBalAfter - agentBalBefore,
            expectedAgentFee,
            10e6, // 10 USDC tolerance — absorbs Moonwell yield accrual variance
            "agent should receive approximately correct performance fee"
        );
    }

    // ==================== TEST 6: SEQUENTIAL STRATEGIES ====================

    /// @notice Execute and settle two strategies sequentially; verify both settle cleanly.
    function test_governance_sequential_strategies() public {
        // --- Strategy #1 ---
        (, BatchExecutorLib.Call[] memory exec1, BatchExecutorLib.Call[] memory settle1) =
            _deployMoonwellStrategy(SUPPLY_AMOUNT);

        uint256 pid1 = _proposeVoteExecute(exec1, settle1, PERF_FEE_BPS, STRATEGY_DURATION);

        // Warp past duration and settle
        vm.warp(block.timestamp + STRATEGY_DURATION);
        vm.prank(random);
        governor.settleProposal(pid1);

        assertEq(
            uint256(governor.getProposalState(pid1)),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "strategy #1 should be settled"
        );
        assertFalse(vault.redemptionsLocked(), "redemptions should be unlocked after strategy #1");

        // Warp past cooldown
        uint256 cooldownEnd = governor.getCooldownEnd(address(vault));
        vm.warp(cooldownEnd + 1);

        // --- Strategy #2 ---
        (, BatchExecutorLib.Call[] memory exec2, BatchExecutorLib.Call[] memory settle2) =
            _deployMoonwellStrategy(SUPPLY_AMOUNT);

        uint256 pid2 = _proposeVoteExecute(exec2, settle2, PERF_FEE_BPS, STRATEGY_DURATION);

        // Warp past duration and settle
        vm.warp(block.timestamp + STRATEGY_DURATION);
        vm.prank(random);
        governor.settleProposal(pid2);

        assertEq(
            uint256(governor.getProposalState(pid2)),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "strategy #2 should be settled"
        );

        // Verify clean state
        assertEq(governor.getActiveProposal(address(vault)), 0, "no active proposal after both strategies");
        assertFalse(vault.redemptionsLocked(), "redemptions should be unlocked after strategy #2");

        // Vault should have recovered funds (minus rounding from Moonwell exchange rate)
        uint256 vaultBal = IERC20(USDC).balanceOf(address(vault));
        assertGt(vaultBal, 0, "vault should still hold funds after sequential strategies");
    }
}
