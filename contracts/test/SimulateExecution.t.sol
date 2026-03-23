// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICToken} from "../src/interfaces/ICToken.sol";
import {ISyndicateGovernor} from "../src/interfaces/ISyndicateGovernor.sol";
import {WstETHMoonwellStrategy} from "../src/strategies/WstETHMoonwellStrategy.sol";

interface IAeroRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function getAmountsOut(uint256 amountIn, Route[] calldata routes) external view returns (uint256[] memory);
}

/**
 * @title SimulateExecution
 * @notice Fork simulation of Proposal #3 execution on flagship-fund.
 *         Run: forge test --fork-url $BASE_RPC_URL --match-contract SimulateExecution -vvvv
 */
contract SimulateExecution is Test {
    // ── Deployed addresses (Base mainnet) ──
    address constant VAULT = 0xa4aF960CAFDe8BF5dc93Fc3b62175968C107892f;
    address constant GOVERNOR = 0x358AD8B492BcC710BE0D7c902D8702164c35DC34;
    address constant CLONE = 0x0550253AFb7b8726906F4769007B65D54f28d1cD;

    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant WSTETH = 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452;
    address constant MWSTETH = 0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b;
    address constant AERO_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERO_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    uint256 constant PROPOSAL_ID = 3;

    function test_diagnoseParams() public view {
        uint256 vaultBalance = IERC20(WETH).balanceOf(VAULT);
        WstETHMoonwellStrategy strategy = WstETHMoonwellStrategy(CLONE);

        uint256 supplyAmount = strategy.supplyAmount();
        uint256 minWstethOut = strategy.minWstethOut();
        uint256 minWethOut = strategy.minWethOut();

        console2.log("=== DIAGNOSIS ===");
        console2.log("Vault WETH balance:", vaultBalance);
        console2.log("Strategy supplyAmount:", supplyAmount);
        console2.log("Strategy minWstethOut:", minWstethOut);
        console2.log("Strategy minWethOut:", minWethOut);
        console2.log("");

        // Check 1: Does vault have enough?
        if (supplyAmount > vaultBalance) {
            console2.log("!! FAIL: supplyAmount > vault balance");
            console2.log("   Shortfall:", supplyAmount - vaultBalance);
        } else {
            console2.log("OK: Vault has enough WETH");
        }

        // Check 2: What does the swap actually return?
        IAeroRouter.Route[] memory routes = new IAeroRouter.Route[](1);
        routes[0] = IAeroRouter.Route({from: WETH, to: WSTETH, stable: true, factory: AERO_FACTORY});
        uint256[] memory amounts = IAeroRouter(AERO_ROUTER).getAmountsOut(supplyAmount, routes);
        uint256 expectedWsteth = amounts[1];

        console2.log("");
        console2.log("=== SWAP SIMULATION ===");
        console2.log("WETH -> wstETH swap output:", expectedWsteth);
        console2.log("minWstethOut required:", minWstethOut);
        if (expectedWsteth < minWstethOut) {
            console2.log("!! FAIL: Swap output < minWstethOut (slippage check will revert)");
        } else {
            console2.log("OK: Swap output >= minWstethOut");
        }

        // Check 3: Reverse swap estimate (for settlement)
        IAeroRouter.Route[] memory reverseRoutes = new IAeroRouter.Route[](1);
        reverseRoutes[0] = IAeroRouter.Route({from: WSTETH, to: WETH, stable: true, factory: AERO_FACTORY});
        uint256[] memory reverseAmounts = IAeroRouter(AERO_ROUTER).getAmountsOut(expectedWsteth, reverseRoutes);
        uint256 expectedWethBack = reverseAmounts[1];

        console2.log("");
        console2.log("=== SETTLEMENT SIMULATION ===");
        console2.log("wstETH -> WETH swap output:", expectedWethBack);
        console2.log("minWethOut required:", minWethOut);
        if (expectedWethBack < minWethOut) {
            console2.log("!! FAIL: Reverse swap output < minWethOut (settle slippage check will revert)");
        } else {
            console2.log("OK: Reverse swap output >= minWethOut");
        }

        // Summary of correct params
        console2.log("");
        console2.log("=== RECOMMENDED PARAMS ===");
        console2.log("supplyAmount should be <=", vaultBalance);
        uint256 safeSupply = vaultBalance * 90 / 100; // use 90% of vault
        console2.log("Suggested supplyAmount (90% of vault):", safeSupply);

        IAeroRouter.Route[] memory routes2 = new IAeroRouter.Route[](1);
        routes2[0] = IAeroRouter.Route({from: WETH, to: WSTETH, stable: true, factory: AERO_FACTORY});
        uint256[] memory amounts2 = IAeroRouter(AERO_ROUTER).getAmountsOut(safeSupply, routes2);
        uint256 safeWsteth = amounts2[1];
        uint256 safeMinWsteth = safeWsteth * 95 / 100; // 5% slippage

        console2.log("Expected wstETH for safe supply:", safeWsteth);
        console2.log("Suggested minWstethOut (5% slippage):", safeMinWsteth);

        IAeroRouter.Route[] memory routes3 = new IAeroRouter.Route[](1);
        routes3[0] = IAeroRouter.Route({from: WSTETH, to: WETH, stable: true, factory: AERO_FACTORY});
        uint256[] memory amounts3 = IAeroRouter(AERO_ROUTER).getAmountsOut(safeWsteth, routes3);
        uint256 safeWethBack = amounts3[1];
        uint256 safeMinWeth = safeWethBack * 95 / 100; // 5% slippage

        console2.log("Expected WETH back on settle:", safeWethBack);
        console2.log("Suggested minWethOut (5% slippage):", safeMinWeth);
    }

    /// @notice Simulate actual execution — will it revert?
    function test_simulateExecution() public {
        uint256 vaultBalance = IERC20(WETH).balanceOf(VAULT);
        console2.log("Vault WETH before execution:", vaultBalance);

        ISyndicateGovernor.ProposalState state = ISyndicateGovernor(GOVERNOR).getProposalState(PROPOSAL_ID);
        console2.log("Proposal state:", uint256(state));
        require(state == ISyndicateGovernor.ProposalState.Approved, "Proposal not in Approved state");

        // Try to execute — this calls governor.executeProposal which does batch delegatecall
        // Anyone can call execute once approved
        ISyndicateGovernor(GOVERNOR).executeProposal(PROPOSAL_ID);

        uint256 vaultBalanceAfter = IERC20(WETH).balanceOf(VAULT);
        console2.log("Vault WETH after execution:", vaultBalanceAfter);
        console2.log("WETH consumed:", vaultBalance - vaultBalanceAfter);

        // Check strategy holds mwstETH
        uint256 mBal = ICToken(MWSTETH).balanceOf(CLONE);
        console2.log("Strategy mwstETH balance:", mBal);
    }

    /// @notice Full lifecycle: execute + warp + settle
    function test_simulateFullLifecycle() public {
        uint256 vaultBefore = IERC20(WETH).balanceOf(VAULT);
        console2.log("Vault WETH before:", vaultBefore);

        // Execute
        ISyndicateGovernor(GOVERNOR).executeProposal(PROPOSAL_ID);

        uint256 vaultAfterExec = IERC20(WETH).balanceOf(VAULT);
        console2.log("Vault WETH after exec:", vaultAfterExec);

        // Warp 1 hour (proposal duration)
        vm.warp(block.timestamp + 1 hours);

        // Settle
        ISyndicateGovernor(GOVERNOR).settleProposal(PROPOSAL_ID);

        uint256 vaultAfterSettle = IERC20(WETH).balanceOf(VAULT);
        console2.log("Vault WETH after settle:", vaultAfterSettle);

        if (vaultAfterSettle >= vaultBefore) {
            console2.log("NET PROFIT:", vaultAfterSettle - vaultBefore);
        } else {
            console2.log("NET LOSS:", vaultBefore - vaultAfterSettle);
        }
    }
}
