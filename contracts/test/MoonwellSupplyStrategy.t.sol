// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {MoonwellSupplyStrategy} from "../src/strategies/MoonwellSupplyStrategy.sol";
import {ICToken} from "../src/interfaces/ICToken.sol";
import {BaseStrategy} from "../src/strategies/BaseStrategy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @notice Minimal mock for Compound/Moonwell cToken
contract MockCToken {
    IERC20 public underlying;
    mapping(address => uint256) public balanceOf;
    uint256 public exchangeRate; // scaled by 1e18

    constructor(address underlying_) {
        underlying = IERC20(underlying_);
        exchangeRate = 1e18; // 1:1 initially
    }

    function setExchangeRate(uint256 rate) external {
        exchangeRate = rate;
    }

    function mint(uint256 mintAmount) external returns (uint256) {
        underlying.transferFrom(msg.sender, address(this), mintAmount);
        // mTokens = mintAmount * 1e18 / exchangeRate
        uint256 mTokens = (mintAmount * 1e18) / exchangeRate;
        balanceOf[msg.sender] += mTokens;
        return 0; // 0 = success
    }

    function redeem(uint256 redeemTokens) external returns (uint256) {
        require(balanceOf[msg.sender] >= redeemTokens, "insufficient mTokens");
        balanceOf[msg.sender] -= redeemTokens;
        // underlyingAmount = redeemTokens * exchangeRate / 1e18
        uint256 underlyingAmount = (redeemTokens * exchangeRate) / 1e18;
        underlying.transfer(msg.sender, underlyingAmount);
        return 0; // 0 = success
    }

    function redeemUnderlying(uint256 redeemAmount) external returns (uint256) {
        uint256 mTokens = (redeemAmount * 1e18) / exchangeRate;
        require(balanceOf[msg.sender] >= mTokens, "insufficient mTokens");
        balanceOf[msg.sender] -= mTokens;
        underlying.transfer(msg.sender, redeemAmount);
        return 0;
    }
}

contract MoonwellSupplyStrategyTest is Test {
    MoonwellSupplyStrategy public template;
    MoonwellSupplyStrategy public strategy;
    ERC20Mock public usdc;
    MockCToken public mUsdc;

    address public vault = makeAddr("vault");
    address public proposer = makeAddr("proposer");

    uint256 constant SUPPLY_AMOUNT = 50_000e6;
    uint256 constant MIN_REDEEM = 49_900e6;

    function setUp() public {
        // Deploy mock tokens
        usdc = new ERC20Mock("USDC", "USDC", 6);
        mUsdc = new MockCToken(address(usdc));

        // Fund the vault
        usdc.mint(vault, 100_000e6);
        // Fund the cToken with underlying for redemptions
        usdc.mint(address(mUsdc), 200_000e6);

        // Deploy template and clone
        template = new MoonwellSupplyStrategy();
        address clone = Clones.clone(address(template));
        strategy = MoonwellSupplyStrategy(clone);

        // Initialize (anyone can initialize — in production the agent does this)
        bytes memory initData = abi.encode(address(usdc), address(mUsdc), SUPPLY_AMOUNT, MIN_REDEEM);
        strategy.initialize(vault, proposer, initData);
    }

    // ==================== INITIALIZATION ====================

    function test_initialize() public view {
        assertEq(strategy.vault(), vault);
        assertEq(strategy.proposer(), proposer);
        assertEq(strategy.underlying(), address(usdc));
        assertEq(strategy.mToken(), address(mUsdc));
        assertEq(strategy.supplyAmount(), SUPPLY_AMOUNT);
        assertEq(strategy.minRedeemAmount(), MIN_REDEEM);
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Pending));
        assertEq(strategy.name(), "Moonwell Supply");
    }

    function test_initialize_twice_reverts() public {
        bytes memory initData = abi.encode(address(usdc), address(mUsdc), SUPPLY_AMOUNT, MIN_REDEEM);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        strategy.initialize(vault, proposer, initData);
    }

    function test_initialize_zeroVault_reverts() public {
        address clone = Clones.clone(address(template));
        bytes memory initData = abi.encode(address(usdc), address(mUsdc), SUPPLY_AMOUNT, MIN_REDEEM);
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        MoonwellSupplyStrategy(clone).initialize(address(0), proposer, initData);
    }

    function test_initialize_zeroAmount_reverts() public {
        address clone = Clones.clone(address(template));
        bytes memory initData = abi.encode(address(usdc), address(mUsdc), 0, MIN_REDEEM);
        vm.expectRevert(MoonwellSupplyStrategy.InvalidAmount.selector);
        MoonwellSupplyStrategy(clone).initialize(vault, proposer, initData);
    }

    // ==================== EXECUTE ====================

    function test_execute() public {
        // Vault approves strategy (this is the first batch call)
        vm.prank(vault);
        usdc.approve(address(strategy), SUPPLY_AMOUNT);

        // Vault calls execute (second batch call)
        vm.prank(vault);
        strategy.execute();

        // Verify: strategy supplied to Moonwell
        assertEq(mUsdc.balanceOf(address(strategy)), SUPPLY_AMOUNT); // 1:1 exchange rate
        assertEq(usdc.balanceOf(vault), 100_000e6 - SUPPLY_AMOUNT); // vault balance reduced
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Executed));
        assertTrue(strategy.executed());
    }

    function test_execute_onlyVault() public {
        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotVault.selector);
        strategy.execute();
    }

    function test_execute_twice_reverts() public {
        vm.prank(vault);
        usdc.approve(address(strategy), SUPPLY_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        vm.prank(vault);
        vm.expectRevert(BaseStrategy.AlreadyExecuted.selector);
        strategy.execute();
    }

    // ==================== SETTLE ====================

    function test_settle() public {
        // Execute first
        vm.prank(vault);
        usdc.approve(address(strategy), SUPPLY_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        uint256 vaultBalBefore = usdc.balanceOf(vault);

        // Settle
        vm.prank(vault);
        strategy.settle();

        // Verify: tokens returned to vault
        uint256 vaultBalAfter = usdc.balanceOf(vault);
        assertEq(vaultBalAfter, vaultBalBefore + SUPPLY_AMOUNT); // 1:1, no yield in mock
        assertEq(mUsdc.balanceOf(address(strategy)), 0); // all mTokens redeemed
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
    }

    function test_settle_withYield() public {
        // Execute
        vm.prank(vault);
        usdc.approve(address(strategy), SUPPLY_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        // Simulate yield accrual: exchange rate goes up 2%
        mUsdc.setExchangeRate(1.02e18);

        uint256 vaultBalBefore = usdc.balanceOf(vault);

        // Settle
        vm.prank(vault);
        strategy.settle();

        // Vault gets back more than supplied (yield!)
        uint256 vaultBalAfter = usdc.balanceOf(vault);
        uint256 returned = vaultBalAfter - vaultBalBefore;
        assertGt(returned, SUPPLY_AMOUNT); // got yield
        assertEq(returned, (SUPPLY_AMOUNT * 1.02e18) / 1e18); // 2% yield
    }

    function test_settle_onlyVault() public {
        vm.prank(vault);
        usdc.approve(address(strategy), SUPPLY_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotVault.selector);
        strategy.settle();
    }

    function test_settle_beforeExecute_reverts() public {
        vm.prank(vault);
        vm.expectRevert(BaseStrategy.NotExecuted.selector);
        strategy.settle();
    }

    function test_settle_minRedeemEnforced() public {
        // Execute
        vm.prank(vault);
        usdc.approve(address(strategy), SUPPLY_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        // Simulate loss: exchange rate drops significantly
        // minRedeemAmount is 49_900e6, if we get less → revert
        // With 50_000 mTokens at 0.5 exchange rate = 25_000 USDC (< 49_900)
        mUsdc.setExchangeRate(0.5e18);

        vm.prank(vault);
        vm.expectRevert(MoonwellSupplyStrategy.InvalidAmount.selector);
        strategy.settle();
    }

    // ==================== PARAM UPDATES ====================

    function test_updateParams_onlyWhenExecuted() public {
        bytes memory newParams = abi.encode(0, 49_800e6);

        // Can't update in Pending state
        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotExecuted.selector);
        strategy.updateParams(newParams);

        // Execute
        vm.prank(vault);
        usdc.approve(address(strategy), SUPPLY_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        // Now can update
        vm.prank(proposer);
        strategy.updateParams(newParams);
        assertEq(strategy.minRedeemAmount(), 49_800e6);
        assertEq(strategy.supplyAmount(), SUPPLY_AMOUNT); // 0 = don't change
    }

    function test_updateParams_onlyProposer() public {
        vm.prank(vault);
        usdc.approve(address(strategy), SUPPLY_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.updateParams(abi.encode(0, 49_800e6));
    }

    function test_updateParams_afterSettled_reverts() public {
        vm.prank(vault);
        usdc.approve(address(strategy), SUPPLY_AMOUNT);
        vm.prank(vault);
        strategy.execute();
        vm.prank(vault);
        strategy.settle();

        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotExecuted.selector);
        strategy.updateParams(abi.encode(0, 49_800e6));
    }

    // ==================== FULL LIFECYCLE ====================

    function test_fullLifecycle_withParamUpdate() public {
        // 1. Execute
        vm.prank(vault);
        usdc.approve(address(strategy), SUPPLY_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        // 2. Yield accrues
        mUsdc.setExchangeRate(1.05e18); // 5% yield

        // 3. Proposer updates minRedeem to account for yield
        vm.prank(proposer);
        strategy.updateParams(abi.encode(0, 52_000e6)); // expect at least 52k back

        // 4. Settle
        vm.prank(vault);
        strategy.settle();

        // Verify
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
        // Vault got 50_000 * 1.05 = 52_500 back
        // Started with 50_000 (100k - 50k supply)
        assertEq(usdc.balanceOf(vault), 100_000e6 - SUPPLY_AMOUNT + 52_500e6);
    }

    // ==================== CLONING ====================

    function test_clonesHaveIsolatedStorage() public {
        address clone2 = Clones.clone(address(template));
        MoonwellSupplyStrategy strategy2 = MoonwellSupplyStrategy(clone2);

        bytes memory initData2 = abi.encode(address(usdc), address(mUsdc), 100_000e6, 99_000e6);
        strategy2.initialize(vault, proposer, initData2);

        assertEq(strategy.supplyAmount(), SUPPLY_AMOUNT);
        assertEq(strategy2.supplyAmount(), 100_000e6);
        assertEq(strategy.minRedeemAmount(), MIN_REDEEM);
        assertEq(strategy2.minRedeemAmount(), 99_000e6);
    }
}
