// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseIntegrationTest} from "../BaseIntegrationTest.sol";
import {MoonwellSupplyStrategy} from "../../../src/strategies/MoonwellSupplyStrategy.sol";
import {ISyndicateGovernor} from "../../../src/interfaces/ISyndicateGovernor.sol";
import {ISyndicateVault} from "../../../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../../../src/BatchExecutorLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICToken} from "../../../src/interfaces/ICToken.sol";

/**
 * @title MoonwellSupplyIntegrationTest
 * @notice Fork tests for MoonwellSupplyStrategy against real Moonwell on Base mainnet.
 *         Validates the full lifecycle: clone, init, propose, vote, execute, accrue yield, settle.
 *
 * @dev Run with: forge test --fork-url $BASE_RPC_URL --match-contract MoonwellSupplyIntegrationTest
 */
contract MoonwellSupplyIntegrationTest is BaseIntegrationTest {
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

    /// @dev Build execution batch calls: [USDC.approve(strategy, amount), strategy.execute()]
    function _buildExecCalls(address strategy) internal pure returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({
            target: USDC, data: abi.encodeCall(IERC20.approve, (strategy, SUPPLY_AMOUNT)), value: 0
        });
        calls[1] = BatchExecutorLib.Call({target: strategy, data: abi.encodeWithSignature("execute()"), value: 0});
    }

    /// @dev Build settlement batch calls: [strategy.settle()]
    function _buildSettleCalls(address strategy) internal pure returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({target: strategy, data: abi.encodeWithSignature("settle()"), value: 0});
    }

    /// @dev Deploy, init, propose, vote, and execute a Moonwell strategy in one shot.
    ///      Returns the strategy clone address and proposal ID.
    function _deployAndExecute() internal returns (address strategy, uint256 proposalId) {
        bytes memory initData = abi.encode(USDC, MOONWELL_MUSDC, SUPPLY_AMOUNT, MIN_REDEEM);
        strategy = _cloneAndInit(moonwellTemplate, initData);

        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);

        proposalId = _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);
    }

    // ==================== TESTS ====================

    /// @notice Full lifecycle: deploy strategy, execute, accrue yield, settle, verify P&L.
    function test_moonwell_fullLifecycle() public {
        uint256 vaultBalBefore = IERC20(USDC).balanceOf(address(vault));

        (address strategy, uint256 proposalId) = _deployAndExecute();

        // After execution: vault USDC should have decreased by supplyAmount
        uint256 vaultBalAfterExec = IERC20(USDC).balanceOf(address(vault));
        assertLt(vaultBalAfterExec, vaultBalBefore, "vault balance should decrease after execution");

        // Strategy should hold mUSDC
        uint256 mUsdcBal = ICToken(MOONWELL_MUSDC).balanceOf(strategy);
        assertGt(mUsdcBal, 0, "strategy should hold mUSDC");

        // Warp past strategy duration
        vm.warp(block.timestamp + STRATEGY_DURATION);

        // Anyone can settle after duration
        vm.prank(random);
        governor.settleProposal(proposalId);

        // Verify: settled state, redemptions unlocked
        assertEq(
            uint256(governor.getProposalState(proposalId)),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "proposal should be settled"
        );
        assertFalse(vault.redemptionsLocked(), "redemptions should be unlocked after settlement");

        // Vault should have recovered funds (minus small rounding from Moonwell exchange rate)
        uint256 vaultBalAfterSettle = IERC20(USDC).balanceOf(address(vault));
        // Allow up to 2 USDC tolerance for Moonwell exchange rate rounding
        assertGe(vaultBalAfterSettle + 2e6, vaultBalBefore, "vault should recover most funds");
    }

    /// @notice Verify real Moonwell yield accrual over 30 days produces a profit.
    function test_moonwell_yieldAccrual() public {
        uint256 vaultBalBefore = IERC20(USDC).balanceOf(address(vault));

        (, uint256 proposalId) = _deployAndExecute();

        // Warp 30 days to accrue real Moonwell yield
        vm.warp(block.timestamp + 30 days);

        vm.prank(random);
        governor.settleProposal(proposalId);

        uint256 vaultBalAfter = IERC20(USDC).balanceOf(address(vault));

        // With real Moonwell lending rates, vault should have earned yield
        // Note: fees are distributed from profit so vault balance includes fees taken
        // The capital snapshot comparison happens inside the governor -- we just check
        // that the vault got back at least what was supplied (real yield > 0 over 30 days)
        assertGe(vaultBalAfter, vaultBalBefore, "vault should have earned yield over 30 days");
    }

    /// @notice Redemptions (withdrawals) should be blocked while a strategy is active.
    function test_moonwell_redemptionLocked() public {
        (, uint256 proposalId) = _deployAndExecute();

        // Redemptions should be locked during active strategy
        assertTrue(vault.redemptionsLocked(), "redemptions should be locked during strategy");

        vm.prank(lp1);
        vm.expectRevert(ISyndicateVault.RedemptionsLocked.selector);
        vault.withdraw(1_000e6, lp1, lp1);

        // Settle the strategy
        vm.warp(block.timestamp + STRATEGY_DURATION);
        vm.prank(random);
        governor.settleProposal(proposalId);

        // Wait for cooldown to elapse
        uint256 cooldownEnd = governor.getCooldownEnd(address(vault));
        vm.warp(cooldownEnd + 1);

        // Withdrawals should work now
        assertFalse(vault.redemptionsLocked(), "redemptions should be unlocked after settlement");

        vm.prank(lp1);
        vault.withdraw(1_000e6, lp1, lp1);
    }

    /// @notice Deposits should be blocked while a strategy is active.
    function test_moonwell_depositsLocked() public {
        _deployAndExecute();

        // Try to deposit as a new LP during active strategy
        address newLp = makeAddr("newLp");
        deal(USDC, newLp, 10_000e6);

        vm.startPrank(newLp);
        IERC20(USDC).approve(address(vault), 10_000e6);
        vm.expectRevert(ISyndicateVault.DepositsLocked.selector);
        vault.deposit(10_000e6, newLp);
        vm.stopPrank();
    }

    /// @notice Anyone can settle after the strategy duration has elapsed.
    function test_moonwell_settleByAnyone() public {
        (, uint256 proposalId) = _deployAndExecute();

        // Warp past duration
        vm.warp(block.timestamp + STRATEGY_DURATION);

        // Random address settles -- should succeed
        vm.prank(random);
        governor.settleProposal(proposalId);

        assertEq(
            uint256(governor.getProposalState(proposalId)),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "random should be able to settle after duration"
        );
    }

    /// @notice positionValue() matches the canonical cToken math against real Moonwell,
    ///         and grows over time as interest accrues.
    function test_moonwell_positionValue_matchesMoonwellMath() public {
        // Before any execution the value is (0, false).
        bytes memory initData = abi.encode(USDC, MOONWELL_MUSDC, SUPPLY_AMOUNT, MIN_REDEEM);
        address strategy = _cloneAndInit(moonwellTemplate, initData);
        (uint256 v0, bool valid0) = MoonwellSupplyStrategy(payable(strategy)).positionValue();
        assertEq(v0, 0, "pre-execute value");
        assertFalse(valid0, "pre-execute valid flag");

        // Execute via full governor lifecycle so state matches prod.
        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);
        uint256 proposalId = _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);

        // Immediately after execute: positionValue should match
        //   cToken.balanceOf(strategy) * cToken.exchangeRateStored() / 1e18
        // against the *real* mUSDC contract, within 1 wei of rounding.
        uint256 cBal = ICToken(MOONWELL_MUSDC).balanceOf(strategy);
        uint256 rate = ICToken(MOONWELL_MUSDC).exchangeRateStored();
        uint256 expected = (cBal * rate) / 1e18;

        (uint256 v1, bool valid1) = MoonwellSupplyStrategy(payable(strategy)).positionValue();
        assertTrue(valid1, "post-execute valid flag");
        assertEq(v1, expected, "positionValue == canonical cToken math");

        // Value should be close to the supplied amount (fresh supply, no accrual yet).
        assertApproxEqAbs(v1, SUPPLY_AMOUNT, 2, "fresh position value ~= supplyAmount");

        // Warp 30 days of real Moonwell interest accrual. Re-read — cToken.balanceOf is
        // unchanged (we didn't mint more) but exchangeRateStored does NOT accrue without
        // a poke. So we poke by calling a non-view function on the cToken that triggers
        // accrueInterest: a zero-value mint from a random address.
        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + (30 days) / 2); // ~2s blocks on Base
        _pokeMoonwellAccrual(MOONWELL_MUSDC);

        uint256 rateAfter = ICToken(MOONWELL_MUSDC).exchangeRateStored();
        (uint256 v2,) = MoonwellSupplyStrategy(payable(strategy)).positionValue();
        assertGt(rateAfter, rate, "exchange rate should grow with accrual");
        assertGt(v2, v1, "positionValue should grow with accrual");

        // Settle and confirm post-settle returns (0, false).
        vm.prank(agent);
        governor.settleProposal(proposalId);
        (uint256 v3, bool valid3) = MoonwellSupplyStrategy(payable(strategy)).positionValue();
        assertEq(v3, 0, "post-settle value");
        assertFalse(valid3, "post-settle valid flag");
    }

    /// @dev Trigger Moonwell's `accrueInterest` so `exchangeRateStored` reflects
    ///      elapsed time. Mint-with-zero would revert; we instead do a 1-wei mint
    ///      from a funded poker address.
    function _pokeMoonwellAccrual(address mToken) internal {
        address poker = makeAddr("poker");
        deal(USDC, poker, 1);
        vm.startPrank(poker);
        IERC20(USDC).approve(mToken, 1);
        ICToken(mToken).mint(1);
        vm.stopPrank();
    }

    /// @notice The proposer (agent) can settle immediately without waiting for duration.
    function test_moonwell_settleByProposer_early() public {
        (, uint256 proposalId) = _deployAndExecute();

        // Agent (proposer) settles immediately -- should succeed
        vm.prank(agent);
        governor.settleProposal(proposalId);

        assertEq(
            uint256(governor.getProposalState(proposalId)),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "proposer should be able to settle early"
        );
        assertFalse(vault.redemptionsLocked(), "redemptions should be unlocked after early settlement");
    }
}
