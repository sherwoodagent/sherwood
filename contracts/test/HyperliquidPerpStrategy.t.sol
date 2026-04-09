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

    function setUp() public {
        usdc = new ERC20Mock("USDC", "USDC", 6);

        // Deploy MockCoreWriter at the expected precompile address so L1Write calls don't revert
        MockCoreWriter cw = new MockCoreWriter();
        vm.etch(0x3333333333333333333333333333333333333333, address(cw).code);

        // Deploy template and clone
        template = new HyperliquidPerpStrategy();
        address payable clone = payable(Clones.clone(address(template)));
        strategy = HyperliquidPerpStrategy(clone);

        // Initialize
        bytes memory initData = abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, LEVERAGE);
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
        assertEq(strategy.positionOpen(), false);
        assertEq(uint8(strategy.settlePhase()), 0); // NONE
        assertEq(uint8(strategy.state()), uint8(BaseStrategy.State.Pending));
        assertEq(strategy.name(), "Hyperliquid Perp");
    }

    function test_initialize_twice_reverts() public {
        bytes memory initData = abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, LEVERAGE);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        strategy.initialize(vault, proposer, initData);
    }

    function test_initialize_zeroAsset_reverts() public {
        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData = abi.encode(address(0), DEPOSIT, MIN_RETURN, PERP_ASSET, LEVERAGE);
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        HyperliquidPerpStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_zeroDeposit_reverts() public {
        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData = abi.encode(address(usdc), 0, MIN_RETURN, PERP_ASSET, LEVERAGE);
        vm.expectRevert(HyperliquidPerpStrategy.InvalidAmount.selector);
        HyperliquidPerpStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_depositTooLarge_reverts() public {
        address payable clone = payable(Clones.clone(address(template)));
        uint256 tooLarge = uint256(type(uint64).max) + 1;
        bytes memory initData = abi.encode(address(usdc), tooLarge, MIN_RETURN, PERP_ASSET, LEVERAGE);
        vm.expectRevert(HyperliquidPerpStrategy.DepositAmountTooLarge.selector);
        HyperliquidPerpStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_zeroLeverage_reverts() public {
        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData = abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, uint32(0));
        vm.expectRevert(HyperliquidPerpStrategy.InvalidAmount.selector);
        HyperliquidPerpStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_leverageTooHigh_reverts() public {
        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData = abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, uint32(51));
        vm.expectRevert(HyperliquidPerpStrategy.InvalidAmount.selector);
        HyperliquidPerpStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_maxLeverage_succeeds() public {
        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData = abi.encode(address(usdc), DEPOSIT, MIN_RETURN, PERP_ASSET, uint32(50));
        HyperliquidPerpStrategy(clone).initialize(vault, proposer, initData);
        assertEq(HyperliquidPerpStrategy(clone).leverage(), 50);
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

        assertEq(strategy.positionOpen(), true);
        assertEq(strategy.stopLossCloidNonce(), 1);
    }

    function test_updateParams_closePosition() public {
        _executeFirst();

        // Open first
        bytes memory openData = abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6));
        vm.prank(proposer);
        strategy.updateParams(openData);

        // Close
        bytes memory closeData = abi.encode(uint8(2), uint64(3100e6), uint64(1e6));
        vm.prank(proposer);
        strategy.updateParams(closeData);

        assertEq(strategy.positionOpen(), false);
    }

    function test_updateParams_closePosition_noPosition_reverts() public {
        _executeFirst();

        bytes memory data = abi.encode(uint8(2), uint64(3100e6), uint64(1e6));
        vm.prank(proposer);
        vm.expectRevert(HyperliquidPerpStrategy.NoOpenPosition.selector);
        strategy.updateParams(data);
    }

    function test_updateParams_updateStopLoss() public {
        _executeFirst();

        // Open first
        bytes memory openData = abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6));
        vm.prank(proposer);
        strategy.updateParams(openData);
        assertEq(strategy.stopLossCloidNonce(), 1);

        // Update stop loss
        bytes memory slData = abi.encode(uint8(3), uint64(2900e6), uint64(1e6));
        vm.prank(proposer);
        strategy.updateParams(slData);

        assertEq(strategy.stopLossCloidNonce(), 2);
    }

    function test_updateParams_updateStopLoss_noPosition_reverts() public {
        _executeFirst();

        bytes memory data = abi.encode(uint8(3), uint64(2900e6), uint64(1e6));
        vm.prank(proposer);
        vm.expectRevert(HyperliquidPerpStrategy.NoOpenPosition.selector);
        strategy.updateParams(data);
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

    // ==================== SETTLE (PHASE 1) ====================

    function test_settle_withOpenPosition() public {
        _executeFirst();

        // Open a position
        bytes memory openData = abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6));
        vm.prank(proposer);
        strategy.updateParams(openData);
        assertTrue(strategy.positionOpen());

        // Settle
        vm.prank(vault);
        strategy.settle();

        assertEq(uint8(strategy.state()), uint8(BaseStrategy.State.Settled));
        assertEq(strategy.positionOpen(), false);
        assertEq(uint8(strategy.settlePhase()), 1); // CLOSING
    }

    function test_settle_withoutOpenPosition() public {
        _executeFirst();

        vm.prank(vault);
        strategy.settle();

        assertEq(uint8(strategy.settlePhase()), 1); // CLOSING
        assertEq(strategy.positionOpen(), false);
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

    // ==================== SWEEP TO VAULT (PHASE 2) ====================

    function test_sweepToVault() public {
        _executeFirst();

        vm.prank(vault);
        strategy.settle();

        // Burn the USDC from execute (simulating HyperCore took it)
        uint256 bal = usdc.balanceOf(address(strategy));
        if (bal > 0) {
            vm.prank(address(strategy));
            usdc.transfer(address(0xdead), bal);
        }

        // Simulate USDC arriving from HyperCore async transfer
        usdc.mint(address(strategy), DEPOSIT);

        uint256 vaultBefore = usdc.balanceOf(vault);
        vm.prank(proposer);
        strategy.sweepToVault();

        assertEq(uint8(strategy.settlePhase()), 2); // SWEEPING
        assertEq(usdc.balanceOf(address(strategy)), 0);
        assertEq(usdc.balanceOf(vault) - vaultBefore, DEPOSIT);
    }

    function test_sweepToVault_enforces_minReturnAmount() public {
        _executeFirst();

        vm.prank(vault);
        strategy.settle();

        // Burn the USDC from execute (simulating HyperCore took it)
        uint256 bal = usdc.balanceOf(address(strategy));
        if (bal > 0) {
            vm.prank(address(strategy));
            usdc.transfer(address(0xdead), bal);
        }

        // Simulate less USDC than minReturnAmount arriving back
        uint256 insufficientAmount = MIN_RETURN - 1;
        usdc.mint(address(strategy), insufficientAmount);

        vm.prank(proposer);
        vm.expectRevert(
            abi.encodeWithSelector(HyperliquidPerpStrategy.InsufficientReturn.selector, insufficientAmount, MIN_RETURN)
        );
        strategy.sweepToVault();
    }

    function test_sweepToVault_zeroBalance_reverts() public {
        _executeFirst();

        vm.prank(vault);
        strategy.settle();

        // In test, execute pulled USDC into the strategy but the precompile mock doesn't
        // actually move it to HyperCore. Burn the balance to simulate zero USDC arriving.
        uint256 bal = usdc.balanceOf(address(strategy));
        if (bal > 0) {
            // Use vm.prank to allow the strategy to transfer
            vm.prank(address(strategy));
            usdc.transfer(address(0xdead), bal);
        }

        vm.prank(proposer);
        vm.expectRevert(HyperliquidPerpStrategy.InvalidAmount.selector);
        strategy.sweepToVault();
    }

    function test_sweepToVault_notProposer_reverts() public {
        _executeFirst();

        vm.prank(vault);
        strategy.settle();

        usdc.mint(address(strategy), DEPOSIT);

        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.sweepToVault();
    }

    function test_sweepToVault_notClosing_reverts() public {
        _executeFirst();

        // Try sweep before settle
        vm.prank(proposer);
        vm.expectRevert(HyperliquidPerpStrategy.NotSweepable.selector);
        strategy.sweepToVault();
    }

    function test_sweepToVault_calledTwice_reverts() public {
        _executeFirst();

        vm.prank(vault);
        strategy.settle();

        usdc.mint(address(strategy), DEPOSIT);

        vm.prank(proposer);
        strategy.sweepToVault();

        // Second call should fail (already SWEEPING)
        vm.prank(proposer);
        vm.expectRevert(HyperliquidPerpStrategy.NotSweepable.selector);
        strategy.sweepToVault();
    }

    function test_sweepToVault_zeroMinReturn_skipsCheck() public {
        // Create a new strategy with minReturnAmount = 0
        address payable clone = payable(Clones.clone(address(template)));
        HyperliquidPerpStrategy strat2 = HyperliquidPerpStrategy(clone);
        bytes memory initData = abi.encode(address(usdc), DEPOSIT, uint256(0), PERP_ASSET, LEVERAGE);
        strat2.initialize(vault, proposer, initData);

        usdc.mint(vault, DEPOSIT);
        vm.prank(vault);
        usdc.approve(address(strat2), type(uint256).max);

        vm.prank(vault);
        strat2.execute();

        vm.prank(vault);
        strat2.settle();

        // Even 1 wei should work when minReturnAmount is 0
        usdc.mint(address(strat2), 1);

        vm.prank(proposer);
        strat2.sweepToVault();

        assertEq(uint8(strat2.settlePhase()), 2); // SWEEPING
    }

    // ==================== FULL LIFECYCLE ====================

    function test_fullLifecycle() public {
        // 1. Execute
        vm.prank(vault);
        strategy.execute();

        // 2. Open position
        bytes memory openData = abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6));
        vm.prank(proposer);
        strategy.updateParams(openData);

        // 3. Update stop loss
        bytes memory slData = abi.encode(uint8(3), uint64(2850e6), uint64(1e6));
        vm.prank(proposer);
        strategy.updateParams(slData);

        // 4. Close position
        bytes memory closeData = abi.encode(uint8(2), uint64(3200e6), uint64(1e6));
        vm.prank(proposer);
        strategy.updateParams(closeData);

        // 5. Settle (phase 1)
        vm.prank(vault);
        strategy.settle();

        // 6. Simulate USDC return
        usdc.mint(address(strategy), DEPOSIT);

        // 7. Sweep (phase 2)
        vm.prank(proposer);
        strategy.sweepToVault();

        // Verify terminal state
        assertEq(uint8(strategy.state()), uint8(BaseStrategy.State.Settled));
        assertEq(uint8(strategy.settlePhase()), 2); // SWEEPING
        assertEq(strategy.positionOpen(), false);
        assertEq(usdc.balanceOf(address(strategy)), 0);
    }

    // ==================== EDGE CASES ====================

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

    function test_sweepToVault_vaultFallbackAfter24h() public {
        _executeFirst();

        vm.prank(vault);
        strategy.settle();

        // Burn execute USDC, simulate async return
        uint256 bal = usdc.balanceOf(address(strategy));
        if (bal > 0) {
            vm.prank(address(strategy));
            usdc.transfer(address(0xdead), bal);
        }
        usdc.mint(address(strategy), DEPOSIT);

        // Vault cannot sweep before 24h
        vm.prank(vault);
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.sweepToVault();

        // Warp 24 hours
        vm.warp(block.timestamp + 24 hours);

        // Now vault can sweep
        uint256 vaultBefore = usdc.balanceOf(vault);
        vm.prank(vault);
        strategy.sweepToVault();

        assertEq(uint8(strategy.settlePhase()), 2); // SWEEPING
        assertEq(usdc.balanceOf(vault) - vaultBefore, DEPOSIT);
    }

    function test_sweepToVault_vaultCannotSweepBefore24h() public {
        _executeFirst();

        vm.prank(vault);
        strategy.settle();

        usdc.mint(address(strategy), DEPOSIT);

        // Warp 23 hours — not enough
        vm.warp(block.timestamp + 23 hours);

        vm.prank(vault);
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.sweepToVault();
    }

    function test_cloidNonce_capped() public {
        _executeFirst();

        // Open a position first
        bytes memory openData = abi.encode(uint8(1), uint64(3000e6), uint64(1e6), uint64(2800e6), uint64(1e6));
        vm.prank(proposer);
        strategy.updateParams(openData);

        // Update stop-loss 199 more times (nonce goes from 1 to 200)
        for (uint256 i = 0; i < 199; i++) {
            bytes memory loopSlData = abi.encode(uint8(3), uint64(2800e6 + uint64(i)), uint64(1e6));
            vm.prank(proposer);
            strategy.updateParams(loopSlData);
        }
        assertEq(strategy.stopLossCloidNonce(), 200);

        // Next stop-loss update should revert — nonce exhausted
        bytes memory slData = abi.encode(uint8(3), uint64(2900e6), uint64(1e6));
        vm.prank(proposer);
        vm.expectRevert(HyperliquidPerpStrategy.CloidNonceExhausted.selector);
        strategy.updateParams(slData);
    }
}
