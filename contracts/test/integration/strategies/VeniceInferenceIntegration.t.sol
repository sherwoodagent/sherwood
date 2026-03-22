// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseIntegrationTest} from "../BaseIntegrationTest.sol";
import {VeniceInferenceStrategy} from "../../../src/strategies/VeniceInferenceStrategy.sol";
import {ISyndicateGovernor} from "../../../src/interfaces/ISyndicateGovernor.sol";
import {BatchExecutorLib} from "../../../src/BatchExecutorLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title VeniceInferenceIntegrationTest
 * @notice Fork tests for VeniceInferenceStrategy against real Venice (sVVV) and
 *         Aerodrome on Base mainnet.
 *
 * @dev IMPORTANT FINDING: sVVV (StakingV2) is NOT_TRANSFERRABLE on Base mainnet.
 *      The strategy's _settle() calls sVVV.transferFrom(agent → strategy) which
 *      reverts. Settlement flow needs redesign — the agent must unstake directly
 *      rather than transferring sVVV back to the strategy.
 *
 *      These tests validate:
 *      - Execution works (staking VVV → sVVV to agent) ✅
 *      - Settlement reverts due to non-transferrable sVVV (known issue) ✅
 *      - Swap path via Aerodrome works for execution ✅
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

    // ==================== EXECUTION TESTS ====================

    /// @notice Direct VVV path: vault → stake VVV → agent receives sVVV.
    function test_venice_directVVV_execution() public {
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

        // Agent pre-approves sVVV (even though transferFrom will fail later,
        // approval itself succeeds)
        vm.prank(agent);
        IERC20(SVVV).approve(strategy, type(uint256).max);

        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy, VVV_TOKEN, vvvAmount);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);
        _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);

        // Execution succeeds: agent holds sVVV, vault VVV is depleted
        assertGt(IERC20(SVVV).balanceOf(agent), 0, "agent should hold sVVV after execution");
        assertEq(IERC20(VVV_TOKEN).balanceOf(address(vault)), 0, "vault VVV should be zero");
    }

    /// @notice Swap path: vault USDC → Aerodrome swap → VVV → stake → agent gets sVVV.
    function test_venice_swapPath_execution() public {
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

        vm.prank(agent);
        IERC20(SVVV).approve(strategy, type(uint256).max);

        uint256 vaultUsdcBefore = IERC20(USDC).balanceOf(address(vault));

        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy, USDC, usdcAmount);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);
        _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);

        // Swap + stake succeeded
        assertGt(IERC20(SVVV).balanceOf(agent), 0, "agent should hold sVVV from swap");
        assertLt(IERC20(USDC).balanceOf(address(vault)), vaultUsdcBefore, "vault USDC should decrease");
    }

    // ==================== SETTLEMENT TESTS ====================

    /// @notice Settlement reverts because sVVV is NOT_TRANSFERRABLE on Base mainnet.
    ///         This is a known issue — the strategy contract needs redesign so the
    ///         agent unstakes directly rather than transferring sVVV to the strategy.
    function test_venice_settlement_reverts_notTransferrable() public {
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

        vm.prank(agent);
        IERC20(SVVV).approve(strategy, type(uint256).max);

        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy, VVV_TOKEN, vvvAmount);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);
        uint256 proposalId = _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);

        // Execution succeeded
        assertGt(IERC20(SVVV).balanceOf(agent), 0, "agent should hold sVVV");

        // Settlement MUST revert because sVVV.transferFrom is NOT_TRANSFERRABLE
        vm.warp(block.timestamp + STRATEGY_DURATION);
        vm.prank(random);
        vm.expectRevert();
        governor.settleProposal(proposalId);
    }

    /// @notice Settle reverts when agent has not pre-approved sVVV clawback.
    ///         (This test passes because transferFrom reverts regardless — but documents
    ///         that the approval step alone is insufficient due to NOT_TRANSFERRABLE.)
    function test_venice_noPreApproval_reverts() public {
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

        // NOTE: Agent does NOT approve sVVV clawback

        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy, VVV_TOKEN, vvvAmount);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);
        uint256 proposalId = _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);

        assertGt(IERC20(SVVV).balanceOf(agent), 0, "agent should hold sVVV");

        vm.warp(block.timestamp + STRATEGY_DURATION);
        vm.prank(random);
        vm.expectRevert();
        governor.settleProposal(proposalId);
    }
}
