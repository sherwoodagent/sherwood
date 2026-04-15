// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Test.sol";
import {RobinhoodIntegrationTest} from "../RobinhoodIntegrationTest.sol";
import {PortfolioStrategy} from "../../../src/strategies/PortfolioStrategy.sol";
import {ISwapAdapter} from "../../../src/interfaces/ISwapAdapter.sol";
import {BatchExecutorLib} from "../../../src/BatchExecutorLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Synthra Quoter interface for diagnostics
interface ISynthraQuoter {
    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint160 sqrtPriceLimitX96
    ) external returns (uint256 amountOut);
}

/**
 * @title PortfolioIntegrationTest
 * @notice Fork tests for PortfolioStrategy on Robinhood L2 testnet.
 *         Validates the full lifecycle against real Synthra DEX pools and stock tokens.
 *
 * @dev Run with:
 *   forge test --fork-url https://rpc.testnet.chain.robinhood.com \
 *     --match-contract PortfolioIntegration -vvvv
 */
contract PortfolioIntegrationTest is RobinhoodIntegrationTest {
    // Use small amounts — testnet pools may have limited liquidity
    uint256 constant TOTAL_AMOUNT = 0.1e18; // 0.1 WETH
    uint256 constant STRATEGY_DURATION = 1 hours;
    uint256 constant PERF_FEE_BPS = 1000; // 10%
    uint24 constant FEE_TIER = 3000; // 0.3% — adjust if pools use different tier

    // ── Helpers ──

    function _buildBasketInitData(address[] memory tokens, uint256[] memory weightsBps, uint256 totalAmt)
        internal
        pure
        returns (bytes memory)
    {
        bytes[] memory extraData = new bytes[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            extraData[i] = abi.encode(uint24(FEE_TIER));
        }

        return abi.encode(
            SYNTHRA_WETH, // asset — Synthra pools use their own WETH
            SYNTHRA_SWAP_ADAPTER,
            CHAINLINK_VERIFIER,
            tokens,
            weightsBps,
            totalAmt,
            uint256(500), // maxSlippageBps = 5%
            extraData
        );
    }

    function _buildExecCalls(address strategy, uint256 amount)
        internal
        pure
        returns (BatchExecutorLib.Call[] memory calls)
    {
        calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({
            target: SYNTHRA_WETH, data: abi.encodeCall(IERC20.approve, (strategy, amount)), value: 0
        });
        calls[1] = BatchExecutorLib.Call({target: strategy, data: abi.encodeWithSignature("execute()"), value: 0});
    }

    function _buildSettleCalls(address strategy) internal pure returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({target: strategy, data: abi.encodeWithSignature("settle()"), value: 0});
    }

    function _deploy3TokenBasket() internal returns (address strategy, uint256 proposalId) {
        address[] memory tokens = new address[](3);
        tokens[0] = TSLA;
        tokens[1] = AMZN;
        tokens[2] = NFLX;

        uint256[] memory weights = new uint256[](3);
        weights[0] = 4000; // 40%
        weights[1] = 3500; // 35%
        weights[2] = 2500; // 25%

        bytes memory initData = _buildBasketInitData(tokens, weights, TOTAL_AMOUNT);
        strategy = _cloneAndInit(PORTFOLIO_TEMPLATE, initData);

        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy, TOTAL_AMOUNT);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);

        proposalId = _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);
    }

    // ── Tests ──

    /// @notice Diagnostic: check Synthra pool liquidity and quote swaps before running lifecycle
    function test_basketIndex_diagnose() public {
        ISynthraQuoter quoter = ISynthraQuoter(SYNTHRA_QUOTER);

        console2.log("=== BASKET INDEX DIAGNOSTICS ===");
        console2.log("Vault WETH balance:", IERC20(SYNTHRA_WETH).balanceOf(address(vault)));
        console2.log("Total amount to deploy:", TOTAL_AMOUNT);
        console2.log("");

        address[3] memory tokens = [TSLA, AMZN, NFLX];
        string[3] memory names = ["TSLA", "AMZN", "NFLX"];
        uint256[3] memory weights = [uint256(4000), 3500, 2500];

        for (uint256 i; i < 3; ++i) {
            uint256 allocation = (TOTAL_AMOUNT * weights[i]) / 10000;
            console2.log("---");
            console2.log(names[i]);
            console2.log("  Weight:", weights[i], "bps");
            console2.log("  WETH allocation:", allocation);

            try quoter.quoteExactInputSingle(SYNTHRA_WETH, tokens[i], FEE_TIER, allocation, 0) returns (
                uint256 amountOut
            ) {
                console2.log("  Expected tokens out:", amountOut);
                console2.log("  OK: Pool exists and has liquidity");
            } catch {
                console2.log("  !! FAIL: No pool or no liquidity for fee tier", uint256(FEE_TIER));
            }
        }
    }

    /// @notice Full lifecycle: execute basket → warp → settle → verify P&L
    function test_basketIndex_fullLifecycle() public {
        uint256 vaultBefore = IERC20(SYNTHRA_WETH).balanceOf(address(vault));
        console2.log("Vault WETH before:", vaultBefore);

        (address strategy, uint256 proposalId) = _deploy3TokenBasket();

        // Verify: vault WETH decreased
        uint256 vaultAfterExec = IERC20(SYNTHRA_WETH).balanceOf(address(vault));
        console2.log("Vault WETH after exec:", vaultAfterExec);
        assertLt(vaultAfterExec, vaultBefore, "vault should have less WETH after execution");

        // Verify: strategy holds stock tokens
        PortfolioStrategy strat = PortfolioStrategy(strategy);
        PortfolioStrategy.TokenAllocation[] memory allocs = strat.getAllocations();
        for (uint256 i; i < allocs.length; ++i) {
            uint256 bal = IERC20(allocs[i].token).balanceOf(strategy);
            console2.log("Strategy token balance:", bal);
            assertGt(bal, 0, "strategy should hold tokens after execution");
            assertEq(allocs[i].tokenAmount, bal, "allocation tokenAmount should match balance");
        }

        // Warp past strategy duration
        vm.warp(block.timestamp + STRATEGY_DURATION);

        // Settle
        governor.settleProposal(proposalId);

        uint256 vaultAfterSettle = IERC20(SYNTHRA_WETH).balanceOf(address(vault));
        console2.log("Vault WETH after settle:", vaultAfterSettle);

        // Log P&L (may be slight loss due to swap fees + slippage)
        if (vaultAfterSettle >= vaultBefore) {
            console2.log("NET PROFIT:", vaultAfterSettle - vaultBefore);
        } else {
            console2.log("NET LOSS:", vaultBefore - vaultAfterSettle);
        }

        // Strategy should hold no tokens
        for (uint256 i; i < allocs.length; ++i) {
            assertEq(IERC20(allocs[i].token).balanceOf(strategy), 0, "strategy should be empty after settle");
        }
    }

    /// @notice Rebalance: execute → update weights → rebalance → settle
    function test_basketIndex_rebalance() public {
        uint256 vaultBefore = IERC20(SYNTHRA_WETH).balanceOf(address(vault));

        (address strategy,) = _deploy3TokenBasket();

        PortfolioStrategy strat = PortfolioStrategy(strategy);

        // Log initial allocations
        console2.log("=== BEFORE REBALANCE ===");
        PortfolioStrategy.TokenAllocation[] memory before = strat.getAllocations();
        for (uint256 i; i < before.length; ++i) {
            console2.log("Token:", before[i].token);
            console2.log("  Weight:", before[i].targetWeightBps);
            console2.log("  Amount:", before[i].tokenAmount);
        }

        // Update weights: TSLA 60%, AMZN 30%, NFLX 10%
        uint256[] memory newWeights = new uint256[](3);
        newWeights[0] = 6000;
        newWeights[1] = 3000;
        newWeights[2] = 1000;

        vm.prank(agent);
        strat.updateParams(abi.encode(newWeights, uint256(0), new bytes[](0)));

        // Rebalance
        vm.prank(agent);
        strat.rebalance();

        // Log post-rebalance allocations
        console2.log("=== AFTER REBALANCE ===");
        PortfolioStrategy.TokenAllocation[] memory after_ = strat.getAllocations();
        for (uint256 i; i < after_.length; ++i) {
            console2.log("Token:", after_[i].token);
            console2.log("  Weight:", after_[i].targetWeightBps);
            console2.log("  Amount:", after_[i].tokenAmount);
            assertGt(after_[i].tokenAmount, 0, "should hold tokens after rebalance");
        }

        // Verify weights changed
        assertEq(after_[0].targetWeightBps, 6000);
        assertEq(after_[1].targetWeightBps, 3000);
        assertEq(after_[2].targetWeightBps, 1000);

        // Warp + settle
        vm.warp(block.timestamp + STRATEGY_DURATION);
        governor.settleProposal(1); // proposalId from _deploy3TokenBasket

        uint256 vaultAfter = IERC20(SYNTHRA_WETH).balanceOf(address(vault));
        console2.log("=== SETTLEMENT ===");
        console2.log("Vault WETH before:", vaultBefore);
        console2.log("Vault WETH after:", vaultAfter);
        if (vaultAfter >= vaultBefore) {
            console2.log("NET PROFIT:", vaultAfter - vaultBefore);
        } else {
            console2.log("NET LOSS:", vaultBefore - vaultAfter);
        }
    }
}
