// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {HyperliquidPerpStrategy} from "../src/strategies/HyperliquidPerpStrategy.sol";
import {BaseStrategy} from "../src/strategies/BaseStrategy.sol";
import {MockCoreWriter} from "./mocks/MockCoreWriter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract HyperliquidPerpStrategyTest is Test {
    HyperliquidPerpStrategy public template;
    HyperliquidPerpStrategy public strategy;
    ERC20Mock public usdc;

    address public vault = makeAddr("vault");
    address public proposer = makeAddr("proposer");
    address public attacker = makeAddr("attacker");

    uint256 constant DEPOSIT = 10_000e6;
    uint256 constant MIN_RETURN = 9_900e6;
    uint32 constant PERP_ASSET = 3; // ETH
    uint32 constant LEVERAGE = 5;
    uint256 constant MAX_POSITION = 100_000e6; // 100k USDC
    uint32 constant MAX_TRADES = 50;

    function setUp() public {
        usdc = new ERC20Mock("USDC", "USDC", 6);

        // Deploy MockCoreWriter at the expected precompile address
        MockCoreWriter cw = new MockCoreWriter();
        vm.etch(0x3333333333333333333333333333333333333333, address(cw).code);

        // Deploy template and clone
        template = new HyperliquidPerpStrategy();
        address payable clone = payable(Clones.clone(address(template)));
        strategy = HyperliquidPerpStrategy(clone);

        bytes memory initData =
            abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, LEVERAGE, MAX_POSITION, MAX_TRADES);
        strategy.initialize(vault, proposer, initData);

        // Fund vault
        usdc.mint(vault, 100_000e6);
        vm.prank(vault);
        usdc.approve(address(strategy), type(uint256).max);
    }

    // ==================== INITIALIZATION ====================

    function test_initialize() public view {
        assertEq(strategy.vault(), vault);
        assertEq(strategy.proposer(), proposer);
        assertEq(address(strategy.asset()), address(usdc));
        assertEq(strategy.depositAmount(), DEPOSIT);
        assertEq(strategy.minReturnAmount(), MIN_RETURN);
        assertEq(strategy.perpAssetIndex(), PERP_ASSET);
        assertEq(strategy.leverage(), LEVERAGE);
        assertEq(strategy.settled(), false);
        assertEq(strategy.cumulativeSwept(), 0);
        assertEq(strategy.hasActiveStopLoss(), false);
        assertEq(strategy.maxPositionSize(), MAX_POSITION);
        assertEq(strategy.maxTradesPerDay(), MAX_TRADES);
        assertEq(uint8(strategy.state()), uint8(BaseStrategy.State.Pending));
        assertEq(strategy.name(), "Hyperliquid Perp");
    }

    function test_initialize_twice_reverts() public {
        bytes memory initData =
            abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, LEVERAGE, MAX_POSITION, MAX_TRADES);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        strategy.initialize(vault, proposer, initData);
    }

    function test_initialize_zeroAsset_reverts() public {
        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData =
            abi.encode(address(0), DEPOSIT, MIN_RETURN, PERP_ASSET, LEVERAGE, MAX_POSITION, MAX_TRADES);
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        HyperliquidPerpStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_zeroDeposit_allowsDynamicAll() public {
        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData = abi.encode(address(usdc), 0, MIN_RETURN, PERP_ASSET, LEVERAGE, MAX_POSITION, MAX_TRADES);
        HyperliquidPerpStrategy(clone).initialize(vault, proposer, initData);
        assertEq(HyperliquidPerpStrategy(clone).depositAmount(), 0);
    }

    function test_execute_dynamicAll_usesFullVaultBalance() public {
        address payable clone = payable(Clones.clone(address(template)));
        HyperliquidPerpStrategy s = HyperliquidPerpStrategy(clone);
        bytes memory initData = abi.encode(address(usdc), 0, MIN_RETURN, PERP_ASSET, LEVERAGE, MAX_POSITION, MAX_TRADES);
        s.initialize(vault, proposer, initData);

        uint256 vaultBalance = usdc.balanceOf(vault);
        vm.prank(vault);
        usdc.approve(address(s), type(uint256).max);

        vm.prank(vault);
        s.execute();

        assertEq(usdc.balanceOf(vault), 0);
        assertEq(usdc.balanceOf(address(s)), vaultBalance);
        assertEq(s.depositAmount(), 0); // stays 0 — dynamic mode is sticky
        assertEq(uint8(s.state()), uint8(BaseStrategy.State.Executed));
    }

    function test_execute_dynamicAll_zeroVaultBalance_reverts() public {
        address payable clone = payable(Clones.clone(address(template)));
        HyperliquidPerpStrategy s = HyperliquidPerpStrategy(clone);
        bytes memory initData = abi.encode(address(usdc), 0, MIN_RETURN, PERP_ASSET, LEVERAGE, MAX_POSITION, MAX_TRADES);
        s.initialize(vault, proposer, initData);

        deal(address(usdc), vault, 0);
        vm.prank(vault);
        usdc.approve(address(s), type(uint256).max);

        vm.prank(vault);
        vm.expectRevert(HyperliquidPerpStrategy.InvalidAmount.selector);
        s.execute();
    }

    function test_execute_dynamicAll_vaultBalanceTooLarge_reverts() public {
        address payable clone = payable(Clones.clone(address(template)));
        HyperliquidPerpStrategy s = HyperliquidPerpStrategy(clone);
        bytes memory initData = abi.encode(address(usdc), 0, MIN_RETURN, PERP_ASSET, LEVERAGE, MAX_POSITION, MAX_TRADES);
        s.initialize(vault, proposer, initData);

        // Fund vault beyond uint64.max
        usdc.mint(vault, uint256(type(uint64).max));
        vm.prank(vault);
        usdc.approve(address(s), type(uint256).max);

        vm.prank(vault);
        vm.expectRevert(HyperliquidPerpStrategy.DepositAmountTooLarge.selector);
        s.execute();
    }

    function test_initialize_depositTooLarge_reverts() public {
        address payable clone = payable(Clones.clone(address(template)));
        uint256 tooLarge = uint256(type(uint64).max) + 1;
        bytes memory initData =
            abi.encode(address(usdc), tooLarge, MIN_RETURN, PERP_ASSET, LEVERAGE, MAX_POSITION, MAX_TRADES);
        vm.expectRevert(HyperliquidPerpStrategy.DepositAmountTooLarge.selector);
        HyperliquidPerpStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_zeroLeverage_reverts() public {
        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData =
            abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, uint32(0), MAX_POSITION, MAX_TRADES);
        vm.expectRevert(HyperliquidPerpStrategy.InvalidAmount.selector);
        HyperliquidPerpStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_leverageTooHigh_reverts() public {
        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData =
            abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, uint32(51), MAX_POSITION, MAX_TRADES);
        vm.expectRevert(HyperliquidPerpStrategy.InvalidAmount.selector);
        HyperliquidPerpStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_maxLeverage_succeeds() public {
        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData =
            abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, uint32(50), MAX_POSITION, MAX_TRADES);
        HyperliquidPerpStrategy(clone).initialize(vault, proposer, initData);
        assertEq(HyperliquidPerpStrategy(clone).leverage(), 50);
    }

    // ==================== POSITION VALUE ====================
    // Inherits BaseStrategy's (0, false) default — HyperCore precompile
    // integration is deferred to a HyperEVM-gated follow-up.

    function test_positionValue_alwaysStubbed() public {
        (uint256 value, bool valid) = strategy.positionValue();
        assertEq(value, 0);
        assertFalse(valid);

        vm.prank(vault);
        strategy.execute();

        (value, valid) = strategy.positionValue();
        assertEq(value, 0);
        assertFalse(valid);
    }

    // ==================== EXECUTE ====================

    function test_execute() public {
        vm.prank(vault);
        strategy.execute();

        assertEq(uint8(strategy.state()), uint8(BaseStrategy.State.Executed));
        assertEq(strategy.leverageSentToCore(), true);
        assertEq(usdc.balanceOf(address(strategy)), DEPOSIT);
    }

    function test_execute_notVault_reverts() public {
        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotVault.selector);
        strategy.execute();
    }

    function test_execute_twice_reverts() public {
        vm.prank(vault);
        strategy.execute();
        vm.prank(vault);
        vm.expectRevert(BaseStrategy.AlreadyExecuted.selector);
        strategy.execute();
    }

    // ==================== UPDATE PARAMS ====================

    function _executeFirst() internal {
        vm.prank(vault);
        strategy.execute();
    }

    function test_updateParams_updateMinReturn() public {
        _executeFirst();
        bytes memory data = abi.encode(uint8(0), uint256(5_000e6));
        vm.prank(proposer);
        strategy.updateParams(data);
        assertEq(strategy.minReturnAmount(), 5_000e6);
    }

    function test_updateParams_openLong() public {
        _executeFirst();
        bytes memory data = abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6));
        vm.prank(proposer);
        strategy.updateParams(data);
        assertEq(strategy.hasActiveStopLoss(), true);
    }

    function test_updateParams_closePosition() public {
        _executeFirst();

        // Open first
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6)));
        assertTrue(strategy.hasActiveStopLoss());

        // Close — stop loss should be cancelled
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint8(2), uint64(3100e6), uint64(1e6)));
        assertFalse(strategy.hasActiveStopLoss());
    }

    function test_updateParams_closeWithoutOpen_succeeds() public {
        // No positionOpen guard — proposer is responsible for checking L1Read
        _executeFirst();
        bytes memory data = abi.encode(uint8(2), uint64(3100e6), uint64(1e6));
        vm.prank(proposer);
        strategy.updateParams(data); // Does not revert
    }

    function test_updateParams_updateStopLoss() public {
        _executeFirst();

        // Open first
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6)));

        // Update stop loss — hasActiveStopLoss stays true
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint8(3), uint64(2900e6), uint64(1e6)));
        assertTrue(strategy.hasActiveStopLoss());
    }

    function test_updateParams_updateStopLossWithoutOpen_succeeds() public {
        _executeFirst();
        bytes memory data = abi.encode(uint8(3), uint64(2900e6), uint64(1e6));
        vm.prank(proposer);
        strategy.updateParams(data); // Does not revert
    }

    function test_updateParams_invalidAction_reverts() public {
        _executeFirst();
        bytes memory data = abi.encode(uint8(99), uint256(0));
        vm.prank(proposer);
        vm.expectRevert(HyperliquidPerpStrategy.InvalidAction.selector);
        strategy.updateParams(data);
    }

    function test_updateParams_notProposer_reverts() public {
        _executeFirst();
        bytes memory data = abi.encode(uint8(0), uint256(5_000e6));
        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.updateParams(data);
    }

    function test_updateParams_notExecuted_reverts() public {
        bytes memory data = abi.encode(uint8(0), uint256(5_000e6));
        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotExecuted.selector);
        strategy.updateParams(data);
    }

    function test_updateParams_emptyData_reverts() public {
        _executeFirst();
        vm.prank(proposer);
        vm.expectRevert(HyperliquidPerpStrategy.InvalidAction.selector);
        strategy.updateParams("");
    }

    function test_updateParams_shortData_reverts() public {
        _executeFirst();
        vm.prank(proposer);
        vm.expectRevert(HyperliquidPerpStrategy.InvalidAction.selector);
        strategy.updateParams(hex"01");
    }

    // ==================== SETTLE ====================

    function test_settle() public {
        _executeFirst();

        // Open a position first
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6)));

        vm.prank(vault);
        strategy.settle();

        assertEq(uint8(strategy.state()), uint8(BaseStrategy.State.Settled));
        assertEq(strategy.settled(), true);
        assertFalse(strategy.hasActiveStopLoss());
    }

    function test_settle_withoutOpenPosition() public {
        _executeFirst();
        vm.prank(vault);
        strategy.settle();
        assertEq(strategy.settled(), true);
    }

    function test_settle_notVault_reverts() public {
        _executeFirst();
        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotVault.selector);
        strategy.settle();
    }

    function test_settle_notExecuted_reverts() public {
        vm.prank(vault);
        vm.expectRevert(BaseStrategy.NotExecuted.selector);
        strategy.settle();
    }

    // ==================== SWEEP TO VAULT ====================

    function _settleFirst() internal {
        _executeFirst();
        vm.prank(vault);
        strategy.settle();
    }

    function _burnStrategyBalance() internal {
        uint256 bal = usdc.balanceOf(address(strategy));
        if (bal > 0) {
            vm.prank(address(strategy));
            usdc.transfer(address(0xdead), bal);
        }
    }

    function test_sweepToVault() public {
        _settleFirst();
        _burnStrategyBalance();

        // Simulate USDC arriving from HyperCore
        usdc.mint(address(strategy), DEPOSIT);

        uint256 vaultBefore = usdc.balanceOf(vault);
        strategy.sweepToVault(); // Anyone can call
        assertEq(strategy.cumulativeSwept(), DEPOSIT);
        assertEq(usdc.balanceOf(address(strategy)), 0);
        assertEq(usdc.balanceOf(vault) - vaultBefore, DEPOSIT);
    }

    function test_sweepToVault_anyoneCanCall() public {
        _settleFirst();
        _burnStrategyBalance();
        usdc.mint(address(strategy), DEPOSIT);

        // Attacker calls — funds still go to vault
        uint256 vaultBefore = usdc.balanceOf(vault);
        vm.prank(attacker);
        strategy.sweepToVault();

        assertEq(usdc.balanceOf(vault) - vaultBefore, DEPOSIT);
        assertEq(usdc.balanceOf(attacker), 0); // Attacker gets nothing
    }

    function test_sweepToVault_enforces_minReturnAmount() public {
        _settleFirst();
        _burnStrategyBalance();

        uint256 insufficientAmount = MIN_RETURN - 1;
        usdc.mint(address(strategy), insufficientAmount);

        // cumulativeSwept (0) + bal (insufficient) < MIN_RETURN
        vm.expectRevert(
            abi.encodeWithSelector(HyperliquidPerpStrategy.InsufficientReturn.selector, insufficientAmount, MIN_RETURN)
        );
        strategy.sweepToVault();
    }

    function test_sweepToVault_zeroBalance_reverts() public {
        _settleFirst();
        _burnStrategyBalance();

        vm.expectRevert(HyperliquidPerpStrategy.InvalidAmount.selector);
        strategy.sweepToVault();
    }

    function test_sweepToVault_notSettled_reverts() public {
        _executeFirst();
        vm.expectRevert(HyperliquidPerpStrategy.NotSweepable.selector);
        strategy.sweepToVault();
    }

    function test_sweepToVault_repeatable() public {
        _settleFirst();
        _burnStrategyBalance();

        // First sweep
        usdc.mint(address(strategy), DEPOSIT);
        strategy.sweepToVault();
        assertEq(strategy.cumulativeSwept(), DEPOSIT);

        // Second sweep — more USDC arrives (partial async)
        usdc.mint(address(strategy), 500e6);
        uint256 vaultBefore = usdc.balanceOf(vault);
        strategy.sweepToVault(); // Does not revert (cumulative >= minReturn)
        assertEq(usdc.balanceOf(vault) - vaultBefore, 500e6);
        assertEq(strategy.cumulativeSwept(), DEPOSIT + 500e6);
    }

    function test_sweepToVault_secondSweepWithCumulativeAboveMin() public {
        _settleFirst();
        _burnStrategyBalance();

        // First sweep with enough funds
        usdc.mint(address(strategy), DEPOSIT);
        strategy.sweepToVault();

        // Second sweep with just 1 wei — succeeds because cumulative (DEPOSIT+1) >= MIN_RETURN
        usdc.mint(address(strategy), 1);
        strategy.sweepToVault(); // Does not revert
    }

    /// @notice #255 S-C6 regression: dust race must not bypass minReturnAmount.
    function test_sweepToVault_dustRaceCannotBypassMinReturn() public {
        _settleFirst();
        _burnStrategyBalance();

        // Attacker triggers first sweep with 100 USDC of dust (< MIN_RETURN = 9_900)
        usdc.mint(address(strategy), 100e6);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpStrategy.InsufficientReturn.selector, 100e6, MIN_RETURN));
        strategy.sweepToVault();
        assertEq(strategy.cumulativeSwept(), 0); // Failed sweep does not advance accumulator

        // More USDC arrives — total now 10,100 > MIN_RETURN
        usdc.mint(address(strategy), 10_000e6);
        strategy.sweepToVault();
        assertEq(strategy.cumulativeSwept(), 10_100e6);
    }

    function test_sweepToVault_zeroMinReturn_skipsCheck() public {
        // Create strategy with minReturnAmount = 0
        address payable clone = payable(Clones.clone(address(template)));
        HyperliquidPerpStrategy strat2 = HyperliquidPerpStrategy(clone);
        bytes memory initData =
            abi.encode(address(usdc), DEPOSIT, uint256(0), PERP_ASSET, LEVERAGE, MAX_POSITION, MAX_TRADES);
        strat2.initialize(vault, proposer, initData);

        usdc.mint(vault, DEPOSIT);
        vm.prank(vault);
        usdc.approve(address(strat2), type(uint256).max);

        vm.prank(vault);
        strat2.execute();
        vm.prank(vault);
        strat2.settle();

        // Even 1 wei should work with minReturnAmount = 0
        usdc.mint(address(strat2), 1);
        strat2.sweepToVault();
        // Strategy still holds DEPOSIT from execute (mock doesn't actually move
        // funds via L1Write.sendUsdClassTransfer), so cumulativeSwept == DEPOSIT + 1
        assertEq(strat2.cumulativeSwept(), DEPOSIT + 1);
    }

    // ==================== FULL LIFECYCLE ====================

    function test_fullLifecycle() public {
        // 1. Execute
        vm.prank(vault);
        strategy.execute();

        // 2. Open position
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6)));

        // 3. Update stop loss
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint8(3), uint64(2850e6), uint64(1e6)));

        // 4. Close position
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint8(2), uint64(3200e6), uint64(1e6)));

        // 5. Settle
        vm.prank(vault);
        strategy.settle();

        // 6. Simulate USDC return
        _burnStrategyBalance();
        usdc.mint(address(strategy), DEPOSIT);

        // 7. Sweep
        strategy.sweepToVault();

        // Verify terminal state
        assertEq(uint8(strategy.state()), uint8(BaseStrategy.State.Settled));
        assertEq(strategy.settled(), true);
        assertGt(strategy.cumulativeSwept(), 0);
        assertEq(usdc.balanceOf(address(strategy)), 0);
    }

    // ==================== STOP LOSS TRACKING ====================

    function test_hasActiveStopLoss_clearedOnClose() public {
        _executeFirst();

        // Open sets hasActiveStopLoss
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6)));
        assertTrue(strategy.hasActiveStopLoss());

        // Close clears it
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint8(2), uint64(3100e6), uint64(1e6)));
        assertFalse(strategy.hasActiveStopLoss());
    }

    function test_hasActiveStopLoss_clearedOnSettle() public {
        _executeFirst();

        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6)));
        assertTrue(strategy.hasActiveStopLoss());

        vm.prank(vault);
        strategy.settle();
        assertFalse(strategy.hasActiveStopLoss());
    }

    // ==================== ON-CHAIN RISK PARAMS ====================

    function test_maxTradesPerDay_reverts() public {
        // Create strategy with maxTradesPerDay = 2
        address payable clone = payable(Clones.clone(address(template)));
        HyperliquidPerpStrategy strat = HyperliquidPerpStrategy(clone);
        strat.initialize(
            vault,
            proposer,
            abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, LEVERAGE, MAX_POSITION, uint32(2))
        );
        usdc.mint(vault, DEPOSIT);
        vm.prank(vault);
        usdc.approve(address(strat), type(uint256).max);
        vm.prank(vault);
        strat.execute();

        // Trade 1 — OK
        vm.prank(proposer);
        strat.updateParams(abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6)));

        // Trade 2 — OK
        vm.prank(proposer);
        strat.updateParams(abi.encode(uint8(2), uint64(3100e6), uint64(1e6)));

        // Trade 3 — exceeds limit
        vm.prank(proposer);
        vm.expectRevert(HyperliquidPerpStrategy.MaxTradesExceeded.selector);
        strat.updateParams(abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6)));
    }

    function test_maxTradesPerDay_resets_daily() public {
        // Create strategy with maxTradesPerDay = 1
        address payable clone = payable(Clones.clone(address(template)));
        HyperliquidPerpStrategy strat = HyperliquidPerpStrategy(clone);
        strat.initialize(
            vault,
            proposer,
            abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, LEVERAGE, MAX_POSITION, uint32(1))
        );
        usdc.mint(vault, DEPOSIT);
        vm.prank(vault);
        usdc.approve(address(strat), type(uint256).max);
        vm.prank(vault);
        strat.execute();

        // Trade 1 — OK
        vm.prank(proposer);
        strat.updateParams(abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6)));

        // Trade 2 — exceeds limit
        vm.prank(proposer);
        vm.expectRevert(HyperliquidPerpStrategy.MaxTradesExceeded.selector);
        strat.updateParams(abi.encode(uint8(2), uint64(3100e6), uint64(1e6)));

        // Warp forward 1 day
        vm.warp(block.timestamp + 1 days);

        // Trade after reset — OK
        vm.prank(proposer);
        strat.updateParams(abi.encode(uint8(2), uint64(3100e6), uint64(1e6)));
    }

    function test_positionTooLarge_reverts() public {
        // Create strategy with maxPositionSize = 1000 USDC
        address payable clone = payable(Clones.clone(address(template)));
        HyperliquidPerpStrategy strat = HyperliquidPerpStrategy(clone);
        strat.initialize(
            vault,
            proposer,
            abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, LEVERAGE, uint256(1000e6), MAX_TRADES)
        );
        usdc.mint(vault, DEPOSIT);
        vm.prank(vault);
        usdc.approve(address(strat), type(uint256).max);
        vm.prank(vault);
        strat.execute();

        // Attempt to open a position worth ~3000 USDC (3000e6 * 1e6 / 1e6 = 3000e6)
        vm.prank(proposer);
        vm.expectRevert(abi.encodeWithSelector(HyperliquidPerpStrategy.PositionTooLarge.selector, 3000e6, 1000e6));
        strat.updateParams(abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6)));
    }

    function test_updateMinReturn_doesNotCountAsTrade() public {
        // Create strategy with maxTradesPerDay = 1
        address payable clone = payable(Clones.clone(address(template)));
        HyperliquidPerpStrategy strat = HyperliquidPerpStrategy(clone);
        strat.initialize(
            vault,
            proposer,
            abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, LEVERAGE, MAX_POSITION, uint32(1))
        );
        usdc.mint(vault, DEPOSIT);
        vm.prank(vault);
        usdc.approve(address(strat), type(uint256).max);
        vm.prank(vault);
        strat.execute();

        // Action 0 (update min return) should NOT count as a trade
        vm.prank(proposer);
        strat.updateParams(abi.encode(uint8(0), uint256(5_000e6)));

        // Trade 1 — should still be allowed (counter not incremented by action 0)
        vm.prank(proposer);
        strat.updateParams(abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6)));
    }
}
