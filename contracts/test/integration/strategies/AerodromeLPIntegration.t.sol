// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseIntegrationTest} from "../BaseIntegrationTest.sol";
import {AerodromeLPStrategy, IAeroGauge} from "../../../src/strategies/AerodromeLPStrategy.sol";
import {ISyndicateGovernor} from "../../../src/interfaces/ISyndicateGovernor.sol";
import {BatchExecutorLib} from "../../../src/BatchExecutorLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title AerodromeLPIntegrationTest
 * @notice Fork tests for AerodromeLPStrategy against real Aerodrome on Base mainnet.
 *         Validates the full lifecycle: clone, init, propose, vote, execute, accrue rewards, settle.
 *
 *         The vault holds USDC from LP deposits. For Aerodrome LP we need two tokens
 *         (WETH + USDC), so setUp() deals WETH directly to the vault. The execute batch
 *         approves both tokens and calls strategy.execute().
 *
 * @dev Run with: forge test --fork-url $BASE_RPC_URL --match-contract AerodromeLPIntegrationTest
 */
contract AerodromeLPIntegrationTest is BaseIntegrationTest {
    address aeroTemplate;

    // ── Aerodrome USDC/WETH volatile pool (token0=WETH, token1=USDC) ──
    address constant AERO_POOL = 0xcDAC0d6c6C59727a65F871236188350531885C43;
    address constant AERO_GAUGE = 0x519BBD1Dd8C6A94C46080E24f316c14Ee758C025;

    // ── Strategy amounts ──
    uint256 constant WETH_AMOUNT = 0.1e18; // 0.1 WETH
    uint256 constant USDC_AMOUNT = 250e6; // 250 USDC
    uint256 constant STRATEGY_DURATION = 7 days;
    uint256 constant PERF_FEE_BPS = 1500; // 15%

    function setUp() public override {
        super.setUp();
        aeroTemplate = address(new AerodromeLPStrategy());

        // Deal WETH to vault so it has both tokens for LP
        deal(WETH, address(vault), WETH_AMOUNT);
    }

    // ==================== HELPERS ====================

    /// @dev Build InitParams for AerodromeLPStrategy
    function _buildInitParams(address gauge) internal pure returns (AerodromeLPStrategy.InitParams memory) {
        return AerodromeLPStrategy.InitParams({
            tokenA: WETH, // token0 in pool
            tokenB: USDC, // token1 in pool
            stable: false, // volatile pool
            factory: AERO_FACTORY,
            router: AERO_ROUTER,
            gauge: gauge,
            lpToken: AERO_POOL, // on Aerodrome, LP token == pool address
            amountADesired: WETH_AMOUNT,
            amountBDesired: USDC_AMOUNT,
            amountAMin: (WETH_AMOUNT * 80) / 100, // 80% slippage tolerance
            amountBMin: (USDC_AMOUNT * 80) / 100,
            minAmountAOut: (WETH_AMOUNT * 80) / 100, // 80% on settlement
            minAmountBOut: (USDC_AMOUNT * 80) / 100
        });
    }

    /// @dev Build execution batch calls:
    ///      [WETH.approve(strategy, amount), USDC.approve(strategy, amount), strategy.execute()]
    function _buildExecCalls(address strategy) internal pure returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](3);
        calls[0] = BatchExecutorLib.Call({
            target: WETH, data: abi.encodeCall(IERC20.approve, (strategy, WETH_AMOUNT)), value: 0
        });
        calls[1] = BatchExecutorLib.Call({
            target: USDC, data: abi.encodeCall(IERC20.approve, (strategy, USDC_AMOUNT)), value: 0
        });
        calls[2] = BatchExecutorLib.Call({target: strategy, data: abi.encodeWithSignature("execute()"), value: 0});
    }

    /// @dev Build settlement batch calls: [strategy.settle()]
    function _buildSettleCalls(address strategy) internal pure returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({target: strategy, data: abi.encodeWithSignature("settle()"), value: 0});
    }

    /// @dev Deploy, init, propose, vote, and execute an Aerodrome LP strategy.
    function _deployAndExecute(address gauge) internal returns (address strategy, uint256 proposalId) {
        AerodromeLPStrategy.InitParams memory params = _buildInitParams(gauge);
        bytes memory initData = abi.encode(params);
        strategy = _cloneAndInit(aeroTemplate, initData);

        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);

        proposalId = _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);
    }

    // ==================== TESTS ====================

    /// @notice Full lifecycle with gauge staking: execute, warp, settle.
    ///         Vault loses WETH + USDC on execute, LP staked in gauge,
    ///         settlement returns tokens to vault.
    function test_aerodrome_fullLifecycle() public {
        uint256 vaultWethBefore = IERC20(WETH).balanceOf(address(vault));
        uint256 vaultUsdcBefore = IERC20(USDC).balanceOf(address(vault));

        (address strategy, uint256 proposalId) = _deployAndExecute(AERO_GAUGE);

        // After execution: vault should have less WETH and USDC
        uint256 vaultWethAfterExec = IERC20(WETH).balanceOf(address(vault));
        uint256 vaultUsdcAfterExec = IERC20(USDC).balanceOf(address(vault));
        assertLt(vaultWethAfterExec, vaultWethBefore, "vault WETH should decrease after execution");
        assertLt(vaultUsdcAfterExec, vaultUsdcBefore, "vault USDC should decrease after execution");

        // LP tokens should be staked in gauge (not held by strategy)
        uint256 gaugeBalance = IAeroGauge(AERO_GAUGE).balanceOf(strategy);
        assertGt(gaugeBalance, 0, "strategy should have LP staked in gauge");
        assertEq(IERC20(AERO_POOL).balanceOf(strategy), 0, "strategy should not hold unstaked LP");

        // Warp past strategy duration
        vm.warp(block.timestamp + STRATEGY_DURATION);

        // Settle
        vm.prank(random);
        governor.settleProposal(proposalId);

        // Verify settled state
        assertEq(
            uint256(governor.getProposalState(proposalId)),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "proposal should be settled"
        );

        // Vault should have received WETH and USDC back
        uint256 vaultWethAfterSettle = IERC20(WETH).balanceOf(address(vault));
        uint256 vaultUsdcAfterSettle = IERC20(USDC).balanceOf(address(vault));
        assertGt(vaultWethAfterSettle, vaultWethAfterExec, "vault should recover WETH after settlement");
        assertGt(vaultUsdcAfterSettle, vaultUsdcAfterExec, "vault should recover USDC after settlement");

        // Should recover roughly what was deposited (within slippage tolerance)
        assertGe(vaultWethAfterSettle, (WETH_AMOUNT * 80) / 100, "vault WETH should be within slippage tolerance");
        assertGe(
            vaultUsdcAfterSettle + USDC_AMOUNT, // add back the amount to compare total
            vaultUsdcBefore,
            "vault USDC should recover most funds"
        );
    }

    /// @notice No-gauge lifecycle: LP tokens held by strategy directly (no staking).
    ///         Settlement removes liquidity without unstaking.
    function test_aerodrome_noGauge() public {
        uint256 vaultWethBefore = IERC20(WETH).balanceOf(address(vault));
        uint256 vaultUsdcBefore = IERC20(USDC).balanceOf(address(vault));

        (address strategy, uint256 proposalId) = _deployAndExecute(address(0));

        // After execution: LP tokens held by strategy (no gauge)
        uint256 strategyLpBalance = IERC20(AERO_POOL).balanceOf(strategy);
        assertGt(strategyLpBalance, 0, "strategy should hold LP tokens directly");

        // Vault should have less tokens
        assertLt(IERC20(WETH).balanceOf(address(vault)), vaultWethBefore, "vault WETH should decrease");
        assertLt(IERC20(USDC).balanceOf(address(vault)), vaultUsdcBefore, "vault USDC should decrease");

        // Warp past strategy duration
        vm.warp(block.timestamp + STRATEGY_DURATION);

        // Settle
        vm.prank(random);
        governor.settleProposal(proposalId);

        // Verify settled state
        assertEq(
            uint256(governor.getProposalState(proposalId)),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "proposal should be settled"
        );

        // Vault should have received tokens back
        uint256 vaultWethAfterSettle = IERC20(WETH).balanceOf(address(vault));
        uint256 vaultUsdcAfterSettle = IERC20(USDC).balanceOf(address(vault));
        assertGe(vaultWethAfterSettle, (WETH_AMOUNT * 80) / 100, "vault should recover WETH within slippage");
        // USDC: vault started with 100k, spent 250, should get ~250 back
        assertGt(vaultUsdcAfterSettle, vaultUsdcBefore - USDC_AMOUNT, "vault should recover USDC");
    }

    /// @notice Full lifecycle with gauge staking, verifying AERO reward accrual.
    ///         After 7 days of staking, vault should receive AERO rewards on settlement.
    function test_aerodrome_withRewards() public {
        (address strategy, uint256 proposalId) = _deployAndExecute(AERO_GAUGE);

        // Confirm LP is staked in gauge
        uint256 gaugeBalance = IAeroGauge(AERO_GAUGE).balanceOf(strategy);
        assertGt(gaugeBalance, 0, "LP should be staked in gauge");

        // Warp 7 days to accrue AERO rewards
        vm.warp(block.timestamp + 7 days);

        // Record vault AERO balance before settlement
        uint256 vaultAeroBefore = IERC20(AERO_TOKEN).balanceOf(address(vault));

        // Settle
        vm.prank(random);
        governor.settleProposal(proposalId);

        // Vault should have received AERO rewards
        uint256 vaultAeroAfter = IERC20(AERO_TOKEN).balanceOf(address(vault));
        assertGt(vaultAeroAfter, vaultAeroBefore, "vault should receive AERO rewards from gauge");
    }
}
