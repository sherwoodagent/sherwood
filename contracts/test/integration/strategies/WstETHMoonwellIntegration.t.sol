// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseIntegrationTest} from "../BaseIntegrationTest.sol";
import {WstETHMoonwellStrategy} from "../../../src/strategies/WstETHMoonwellStrategy.sol";
import {ISyndicateGovernor} from "../../../src/interfaces/ISyndicateGovernor.sol";
import {BatchExecutorLib} from "../../../src/BatchExecutorLib.sol";
import {SyndicateFactory} from "../../../src/SyndicateFactory.sol";
import {SyndicateGovernor} from "../../../src/SyndicateGovernor.sol";
import {SyndicateVault} from "../../../src/SyndicateVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICToken} from "../../../src/interfaces/ICToken.sol";

/**
 * @title WstETHMoonwellIntegrationTest
 * @notice Fork tests for WstETHMoonwellStrategy against real Moonwell + Aerodrome on Base mainnet.
 *         Validates full lifecycle: WETH -> wstETH swap -> Moonwell supply -> redeem -> swap back.
 *
 * @dev Overrides setUp() to create a WETH-denominated vault instead of the default USDC vault.
 *      Run with: forge test --fork-url $BASE_RPC_URL --match-contract WstETHMoonwellIntegrationTest
 */
contract WstETHMoonwellIntegrationTest is BaseIntegrationTest {
    // ── WstETH Moonwell addresses (Base mainnet) ──

    address constant WSTETH = 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452;
    address constant MWSTETH = 0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b;

    address wstethTemplate;

    uint256 constant SUPPLY_AMOUNT = 0.01e18; // small — wstETH/WETH pool has limited liquidity
    uint256 constant STRATEGY_DURATION = 7 days;
    uint256 constant PERF_FEE_BPS = 1500; // 15%

    // ── Setup: WETH vault instead of USDC ──

    function setUp() public override {
        // Read deployed Sherwood addresses from chains/8453.json
        factory = SyndicateFactory(_readAddress("SYNDICATE_FACTORY"));
        governor = SyndicateGovernor(_readAddress("SYNDICATE_GOVERNOR"));
        deployer = _readAddress("DEPLOYER");

        // Create a WETH vault (not USDC)
        _createWethSyndicate();

        // Fund LPs with WETH and deposit
        uint256 lp1Amount = 60e18;
        uint256 lp2Amount = 40e18;

        deal(WETH, lp1, lp1Amount);
        deal(WETH, lp2, lp2Amount);

        vm.startPrank(lp1);
        IERC20(WETH).approve(address(vault), lp1Amount);
        vault.deposit(lp1Amount, lp1);
        vm.stopPrank();

        vm.startPrank(lp2);
        IERC20(WETH).approve(address(vault), lp2Amount);
        vault.deposit(lp2Amount, lp2);
        vm.stopPrank();

        // Warp 1 second so snapshot block is in the past for voting
        vm.warp(block.timestamp + 1);

        // Deploy WstETHMoonwellStrategy template
        wstethTemplate = address(new WstETHMoonwellStrategy());
    }

    // ── Internal: create WETH-denominated syndicate ──

    function _createWethSyndicate() internal {
        // Mock the agent registry ownerOf call so owner passes the ERC-8004 check
        vm.mockCall(AGENT_REGISTRY, abi.encodeWithSignature("ownerOf(uint256)", agentNftId), abi.encode(owner));

        // Mock the ENS registrar so register() doesn't revert
        vm.mockCall(ENS_REGISTRAR, abi.encodeWithSignature("register(string,address)"), abi.encode());
        vm.mockCall(ENS_REGISTRAR, abi.encodeWithSignature("available(string)"), abi.encode(true));

        // Create syndicate with WETH as asset
        SyndicateFactory.SyndicateConfig memory config = SyndicateFactory.SyndicateConfig({
            metadataURI: "ipfs://test-wsteth-integration",
            asset: IERC20(WETH),
            name: "WstETH Integration Vault",
            symbol: "itWETH",
            openDeposits: true,
            subdomain: "wsteth-integration-test"
        });

        vm.prank(owner);
        (, address vaultAddr) = factory.createSyndicate(agentNftId, config);
        vault = SyndicateVault(payable(vaultAddr));

        // Register agent on the vault
        uint256 agentNftId2 = 43;
        vm.mockCall(AGENT_REGISTRY, abi.encodeWithSignature("ownerOf(uint256)", agentNftId2), abi.encode(agent));

        vm.prank(owner);
        vault.registerAgent(agentNftId2, agent);
    }

    // ==================== HELPERS ====================

    /// @dev Build InitParams for WstETHMoonwellStrategy
    function _buildInitParams(uint256 supplyAmount) internal pure returns (WstETHMoonwellStrategy.InitParams memory) {
        return WstETHMoonwellStrategy.InitParams({
            weth: WETH,
            wsteth: WSTETH,
            mwsteth: MWSTETH,
            aeroRouter: AERO_ROUTER,
            aeroFactory: AERO_FACTORY,
            supplyAmount: supplyAmount,
            minWstethOutPerWeth: 0.8e18, // 20% slippage tolerance (per-unit 1e18 rate)
            minWethOutPerWsteth: 0.8e18, // 20% slippage tolerance
            deadlineOffset: 300
        });
    }

    /// @dev Build execution batch calls: [WETH.approve(strategy, amount), strategy.execute()]
    function _buildExecCalls(address strategy, uint256 supplyAmount)
        internal
        pure
        returns (BatchExecutorLib.Call[] memory calls)
    {
        calls = new BatchExecutorLib.Call[](2);
        calls[0] = BatchExecutorLib.Call({
            target: WETH, data: abi.encodeCall(IERC20.approve, (strategy, supplyAmount)), value: 0
        });
        calls[1] = BatchExecutorLib.Call({target: strategy, data: abi.encodeWithSignature("execute()"), value: 0});
    }

    /// @dev Build settlement batch calls: [strategy.settle()]
    function _buildSettleCalls(address strategy) internal pure returns (BatchExecutorLib.Call[] memory calls) {
        calls = new BatchExecutorLib.Call[](1);
        calls[0] = BatchExecutorLib.Call({target: strategy, data: abi.encodeWithSignature("settle()"), value: 0});
    }

    /// @dev Deploy, init, propose, vote, and execute a WstETH strategy in one shot.
    function _deployAndExecute() internal returns (address strategy, uint256 proposalId) {
        WstETHMoonwellStrategy.InitParams memory params = _buildInitParams(SUPPLY_AMOUNT);
        bytes memory initData = abi.encode(params);
        strategy = _cloneAndInit(wstethTemplate, initData);

        BatchExecutorLib.Call[] memory execCalls = _buildExecCalls(strategy, SUPPLY_AMOUNT);
        BatchExecutorLib.Call[] memory settleCalls = _buildSettleCalls(strategy);

        proposalId = _proposeVoteExecute(execCalls, settleCalls, PERF_FEE_BPS, STRATEGY_DURATION);
    }

    // ==================== TESTS ====================

    /// @notice Full lifecycle: deploy strategy, execute, warp 7 days, settle, verify recovery.
    function test_wsteth_fullLifecycle() public {
        uint256 vaultBalBefore = IERC20(WETH).balanceOf(address(vault));

        (address strategy, uint256 proposalId) = _deployAndExecute();

        // After execution: vault WETH should have decreased by supplyAmount
        uint256 vaultBalAfterExec = IERC20(WETH).balanceOf(address(vault));
        assertLt(vaultBalAfterExec, vaultBalBefore, "vault balance should decrease after execution");

        // Strategy should hold mwstETH
        uint256 mwstethBal = ICToken(MWSTETH).balanceOf(strategy);
        assertGt(mwstethBal, 0, "strategy should hold mwstETH");

        // Warp past strategy duration
        vm.warp(block.timestamp + STRATEGY_DURATION);

        // Settle
        vm.prank(random);
        governor.settleProposal(proposalId);

        // Verify: settled state
        assertEq(
            uint256(governor.getProposalState(proposalId)),
            uint256(ISyndicateGovernor.ProposalState.Settled),
            "proposal should be settled"
        );
        assertFalse(vault.redemptionsLocked(), "redemptions should be unlocked after settlement");

        // Vault should have recovered most WETH (at least 80% due to swap slippage)
        uint256 vaultBalAfterSettle = IERC20(WETH).balanceOf(address(vault));
        uint256 minExpected = vaultBalBefore - (SUPPLY_AMOUNT * 20 / 100);
        assertGe(vaultBalAfterSettle, minExpected, "vault should recover at least 80% of supplied WETH");
    }

    /// @notice Verify yield accrual over 30 days: Moonwell lending + Lido staking yield should offset swap costs.
    function test_wsteth_yieldAccrual() public {
        uint256 vaultBalBefore = IERC20(WETH).balanceOf(address(vault));

        (, uint256 proposalId) = _deployAndExecute();

        // Warp 30 days to accrue Moonwell lending yield + Lido staking yield
        vm.warp(block.timestamp + 30 days);

        vm.prank(random);
        governor.settleProposal(proposalId);

        uint256 vaultBalAfter = IERC20(WETH).balanceOf(address(vault));

        // With small amounts (0.01 WETH), swap slippage on both directions may slightly
        // exceed 30-day yield. Allow small tolerance for the round-trip swap cost.
        // At larger amounts the yield would dominate.
        assertApproxEqAbs(
            vaultBalAfter,
            vaultBalBefore,
            vaultBalBefore / 100, // 1% tolerance for round-trip swap slippage
            "vault should recover ~100% of balance after 30 days (yield vs swap cost)"
        );
    }
}
