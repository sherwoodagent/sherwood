// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseIntegrationTest} from "../BaseIntegrationTest.sol";
import {VeniceInferenceStrategy} from "../../../src/strategies/VeniceInferenceStrategy.sol";
import {BatchExecutorLib} from "../../../src/BatchExecutorLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title VeniceInferenceIntegrationTest
 * @notice Fork tests for the loan-model VeniceInferenceStrategy against real
 *         Venice (sVVV) and Aerodrome on Base mainnet.
 *
 *         Settlement no longer claws back sVVV (non-transferrable). Instead the
 *         agent repays the vault in the vault's asset (USDC or VVV). sVVV stays
 *         with the agent permanently as their inference license.
 *
 * Run with: forge test --fork-url $BASE_RPC_URL --match-contract VeniceInferenceIntegrationTest
 */
contract VeniceInferenceIntegrationTest is BaseIntegrationTest {
    address veniceTemplate;

    uint256 constant STRATEGY_DURATION = 7 days;
    uint256 constant PERF_FEE_BPS = 0; // no fee — Venice is infra, not yield

    function setUp() public override {
        super.setUp();
        veniceTemplate = address(new VeniceInferenceStrategy());
    }

    // ==================== HELPERS ====================

    function _buildExecCalls(address strategy, address asset, uint256 amount)
        internal
        pure
        returns (BatchExecutorLib.Call[] memory calls)
    {
        calls = new BatchExecutorLib.Call[](2);
        calls[0] =
            BatchExecutorLib.Call({target: asset, data: abi.encodeCall(IERC20.approve, (strategy, amount)), value: 0});
        calls[1] = BatchExecutorLib.Call({target: strategy, data: abi.encodeWithSignature("execute()"), value: 0});
    }

    function _buildSettleCalls(address strategy) internal pure returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({target: strategy, data: abi.encodeWithSignature("settle()"), value: 0});
    }

    // ==================== TESTS ====================

    /// @notice Direct VVV path: vault lends VVV → stake → agent gets sVVV.
    ///         Agent earns VVV off-chain, repays vault in VVV. sVVV stays with agent.
    function test_venice_directVVV_loanAndRepay() public {
        uint256 vvvAmount = 500e18;
        deal(VVV_TOKEN, address(vault), vvvAmount);

        bytes memory initData = abi.encode(
            VeniceInferenceStrategy.InitParams({
                asset: VVV_TOKEN,
                weth: address(0),
                vvv: VVV_TOKEN,
                sVVV: SVVV,
                aeroRouter: address(0),
                aeroFactory: address(0),
                agent: agent,
                assetAmount: vvvAmount,
                minVVV: 0,
                deadlineOffset: 0,
                singleHop: false
            })
        );
        address strategy = _cloneAndInit(veniceTemplate, initData);

        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy, VVV_TOKEN, vvvAmount);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);
        uint256 proposalId = _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);

        // Execution succeeded: agent holds sVVV, vault VVV depleted
        uint256 agentSVVV = IERC20(SVVV).balanceOf(agent);
        assertGt(agentSVVV, 0, "agent should hold sVVV after execution");
        assertEq(IERC20(VVV_TOKEN).balanceOf(address(vault)), 0, "vault VVV should be zero after execution");

        // --- Agent earns off-chain and repays ---
        // Simulate agent earning VVV from off-chain inference trading
        deal(VVV_TOKEN, agent, vvvAmount);

        // Agent approves STRATEGY (not vault) to pull repayment
        vm.prank(agent);
        IERC20(VVV_TOKEN).approve(strategy, vvvAmount);

        // Warp past duration, settle
        vm.warp(block.timestamp + STRATEGY_DURATION);
        vm.prank(random);
        governor.settleProposal(proposalId);

        // Assert: vault received VVV back
        assertEq(IERC20(VVV_TOKEN).balanceOf(address(vault)), vvvAmount, "vault should receive VVV repayment");

        // Assert: agent still holds sVVV (non-transferrable, stays permanently)
        assertEq(IERC20(SVVV).balanceOf(agent), agentSVVV, "agent should still hold sVVV after settlement");
    }

    /// @notice Swap path: vault USDC → Aerodrome swap to VVV → stake → agent gets sVVV.
    ///         Agent earns USDC off-chain and repays vault in USDC.
    function test_venice_swapPath_loanAndRepay() public {
        uint256 usdcAmount = 500e6;

        bytes memory initData = abi.encode(
            VeniceInferenceStrategy.InitParams({
                asset: USDC,
                weth: WETH,
                vvv: VVV_TOKEN,
                sVVV: SVVV,
                aeroRouter: AERO_ROUTER,
                aeroFactory: AERO_FACTORY,
                agent: agent,
                assetAmount: usdcAmount,
                minVVV: 1, // minimal slippage for fork test
                deadlineOffset: 300,
                singleHop: false
            })
        );
        address strategy = _cloneAndInit(veniceTemplate, initData);

        uint256 vaultUsdcBefore = IERC20(USDC).balanceOf(address(vault));

        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy, USDC, usdcAmount);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);
        uint256 proposalId = _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);

        // Execution succeeded: agent holds sVVV, vault USDC decreased
        uint256 agentSVVV = IERC20(SVVV).balanceOf(agent);
        assertGt(agentSVVV, 0, "agent should hold sVVV from swap path");
        assertLt(IERC20(USDC).balanceOf(address(vault)), vaultUsdcBefore, "vault USDC should decrease");

        // --- Agent earns USDC off-chain and repays ---
        deal(USDC, agent, usdcAmount);

        // Agent approves STRATEGY to pull USDC repayment
        vm.prank(agent);
        IERC20(USDC).approve(strategy, usdcAmount);

        // Warp past duration, settle
        vm.warp(block.timestamp + STRATEGY_DURATION);
        vm.prank(random);
        governor.settleProposal(proposalId);

        // Assert: vault USDC increased (got repayment back on top of remaining balance)
        uint256 vaultUsdcAfter = IERC20(USDC).balanceOf(address(vault));
        assertGe(vaultUsdcAfter, vaultUsdcBefore, "vault USDC should be at least restored after repayment");

        // Assert: agent still holds sVVV
        assertEq(IERC20(SVVV).balanceOf(agent), agentSVVV, "agent should still hold sVVV after settlement");
    }

    /// @notice Agent repays more than principal (principal + profit) via updateParams.
    function test_venice_repayWithProfit() public {
        uint256 vvvAmount = 500e18;
        uint256 profitAmount = 100e18;
        uint256 totalRepayment = vvvAmount + profitAmount; // 600e18

        deal(VVV_TOKEN, address(vault), vvvAmount);

        bytes memory initData = abi.encode(
            VeniceInferenceStrategy.InitParams({
                asset: VVV_TOKEN,
                weth: address(0),
                vvv: VVV_TOKEN,
                sVVV: SVVV,
                aeroRouter: address(0),
                aeroFactory: address(0),
                agent: agent,
                assetAmount: vvvAmount,
                minVVV: 0,
                deadlineOffset: 0,
                singleHop: false
            })
        );
        address strategy = _cloneAndInit(veniceTemplate, initData);

        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy, VVV_TOKEN, vvvAmount);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);
        uint256 proposalId = _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);

        // Execution succeeded
        assertGt(IERC20(SVVV).balanceOf(agent), 0, "agent should hold sVVV after execution");

        // Agent updates repaymentAmount to include profit
        vm.prank(agent);
        VeniceInferenceStrategy(strategy).updateParams(abi.encode(totalRepayment, uint256(0), uint256(0)));
        assertEq(
            VeniceInferenceStrategy(strategy).repaymentAmount(),
            totalRepayment,
            "repaymentAmount should be updated"
        );

        // Agent earned 600 VVV total off-chain (principal + profit)
        deal(VVV_TOKEN, agent, totalRepayment);

        // Agent approves strategy for the full repayment
        vm.prank(agent);
        IERC20(VVV_TOKEN).approve(strategy, totalRepayment);

        // Warp past duration, settle
        vm.warp(block.timestamp + STRATEGY_DURATION);
        vm.prank(random);
        governor.settleProposal(proposalId);

        // Assert: vault received 600e18 VVV (more than the 500e18 principal)
        assertEq(
            IERC20(VVV_TOKEN).balanceOf(address(vault)),
            totalRepayment,
            "vault should receive principal + profit"
        );
    }

    /// @notice Settlement reverts when agent cannot repay (insufficient asset balance).
    function test_venice_agentCantRepay_reverts() public {
        uint256 vvvAmount = 500e18;
        deal(VVV_TOKEN, address(vault), vvvAmount);

        bytes memory initData = abi.encode(
            VeniceInferenceStrategy.InitParams({
                asset: VVV_TOKEN,
                weth: address(0),
                vvv: VVV_TOKEN,
                sVVV: SVVV,
                aeroRouter: address(0),
                aeroFactory: address(0),
                agent: agent,
                assetAmount: vvvAmount,
                minVVV: 0,
                deadlineOffset: 0,
                singleHop: false
            })
        );
        address strategy = _cloneAndInit(veniceTemplate, initData);

        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy, VVV_TOKEN, vvvAmount);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);
        uint256 proposalId = _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);

        // Execution succeeded
        assertGt(IERC20(SVVV).balanceOf(agent), 0, "agent should hold sVVV after execution");

        // Agent does NOT have VVV to repay — don't deal them anything
        assertEq(IERC20(VVV_TOKEN).balanceOf(agent), 0, "agent should have no VVV");

        // Warp past duration, settle should revert (safeTransferFrom fails)
        vm.warp(block.timestamp + STRATEGY_DURATION);
        vm.prank(random);
        vm.expectRevert();
        governor.settleProposal(proposalId);
    }
}
