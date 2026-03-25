// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {MamoYieldStrategy} from "../src/strategies/MamoYieldStrategy.sol";
import {BaseStrategy} from "../src/strategies/BaseStrategy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @notice Mock Mamo ERC20 strategy that holds deposited tokens and simulates yield
contract MockMamoStrategy {
    using SafeERC20 for IERC20;

    IERC20 public token;
    address public owner;
    uint256 public deposited;
    uint256 public yieldBps; // extra yield in basis points (0 = no yield, 200 = 2%)

    constructor(address token_, address owner_) {
        token = IERC20(token_);
        owner = owner_;
    }

    function setYieldBps(uint256 bps) external {
        yieldBps = bps;
    }

    function deposit(uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        deposited += amount;
    }

    function withdrawAll() external {
        require(msg.sender == owner, "not owner");
        uint256 amount = deposited + (deposited * yieldBps) / 10000;
        uint256 balance = token.balanceOf(address(this));
        // Transfer the lesser of expected and actual balance (simulates loss)
        uint256 toTransfer = amount < balance ? amount : balance;
        deposited = 0;
        token.safeTransfer(msg.sender, toTransfer);
    }

    function withdraw(uint256 amount) external {
        require(msg.sender == owner, "not owner");
        deposited -= amount;
        token.safeTransfer(msg.sender, amount);
    }
}

/// @notice Mock Mamo StrategyFactory that deploys MockMamoStrategy instances
contract MockMamoFactory {
    address public token;
    mapping(address => address) public strategies;

    constructor(address token_) {
        token = token_;
    }

    function createStrategyForUser(address user) external returns (address strategy) {
        MockMamoStrategy s = new MockMamoStrategy(token, user);
        strategies[user] = address(s);
        return address(s);
    }
}

contract MamoYieldStrategyTest is Test {
    MamoYieldStrategy public template;
    MamoYieldStrategy public strategy;
    ERC20Mock public usdc;
    MockMamoFactory public mamoFactory;

    address public vault = makeAddr("vault");
    address public proposer = makeAddr("proposer");

    uint256 constant SUPPLY_AMOUNT = 50_000e6;
    uint256 constant MIN_REDEEM = 49_900e6;

    function setUp() public {
        // Deploy mock tokens
        usdc = new ERC20Mock("USDC", "USDC", 6);
        mamoFactory = new MockMamoFactory(address(usdc));

        // Fund the vault
        usdc.mint(vault, 100_000e6);

        // Deploy template and clone
        template = new MamoYieldStrategy();
        address clone = Clones.clone(address(template));
        strategy = MamoYieldStrategy(clone);

        // Initialize
        bytes memory initData = abi.encode(address(usdc), address(mamoFactory), SUPPLY_AMOUNT, MIN_REDEEM);
        strategy.initialize(vault, proposer, initData);
    }

    // ==================== INITIALIZATION ====================

    function test_initialize() public view {
        assertEq(strategy.vault(), vault);
        assertEq(strategy.proposer(), proposer);
        assertEq(strategy.underlying(), address(usdc));
        assertEq(strategy.mamoFactory(), address(mamoFactory));
        assertEq(strategy.supplyAmount(), SUPPLY_AMOUNT);
        assertEq(strategy.minRedeemAmount(), MIN_REDEEM);
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Pending));
        assertEq(strategy.name(), "Mamo Yield");
    }

    function test_initialize_twice_reverts() public {
        bytes memory initData = abi.encode(address(usdc), address(mamoFactory), SUPPLY_AMOUNT, MIN_REDEEM);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        strategy.initialize(vault, proposer, initData);
    }

    function test_initialize_zeroVault_reverts() public {
        address clone = Clones.clone(address(template));
        bytes memory initData = abi.encode(address(usdc), address(mamoFactory), SUPPLY_AMOUNT, MIN_REDEEM);
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        MamoYieldStrategy(clone).initialize(address(0), proposer, initData);
    }

    function test_initialize_zeroUnderlying_reverts() public {
        address clone = Clones.clone(address(template));
        bytes memory initData = abi.encode(address(0), address(mamoFactory), SUPPLY_AMOUNT, MIN_REDEEM);
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        MamoYieldStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_zeroFactory_reverts() public {
        address clone = Clones.clone(address(template));
        bytes memory initData = abi.encode(address(usdc), address(0), SUPPLY_AMOUNT, MIN_REDEEM);
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        MamoYieldStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_zeroAmount_reverts() public {
        address clone = Clones.clone(address(template));
        bytes memory initData = abi.encode(address(usdc), address(mamoFactory), 0, MIN_REDEEM);
        vm.expectRevert(MamoYieldStrategy.InvalidAmount.selector);
        MamoYieldStrategy(clone).initialize(vault, proposer, initData);
    }

    // ==================== EXECUTE ====================

    function test_execute() public {
        // Vault approves strategy (first batch call)
        vm.prank(vault);
        usdc.approve(address(strategy), SUPPLY_AMOUNT);

        // Vault calls execute (second batch call)
        vm.prank(vault);
        strategy.execute();

        // Verify: Mamo strategy was created and funded
        address mamoStrategy = strategy.mamoStrategy();
        assertTrue(mamoStrategy != address(0));
        assertEq(usdc.balanceOf(mamoStrategy), SUPPLY_AMOUNT); // tokens deposited into Mamo
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
        _executeStrategy();

        uint256 vaultBalBefore = usdc.balanceOf(vault);

        // Settle
        vm.prank(vault);
        strategy.settle();

        // Verify: tokens returned to vault
        uint256 vaultBalAfter = usdc.balanceOf(vault);
        assertEq(vaultBalAfter, vaultBalBefore + SUPPLY_AMOUNT); // no yield in default mock
        assertEq(usdc.balanceOf(strategy.mamoStrategy()), 0); // Mamo strategy drained
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
    }

    function test_settle_withYield() public {
        _executeStrategy();

        // Simulate yield accrual: 2% yield on Mamo strategy
        address mamoStrategy = strategy.mamoStrategy();
        MockMamoStrategy(mamoStrategy).setYieldBps(200); // 2%
        // Fund the mock Mamo strategy with yield tokens
        usdc.mint(mamoStrategy, (SUPPLY_AMOUNT * 200) / 10000);

        uint256 vaultBalBefore = usdc.balanceOf(vault);

        // Settle
        vm.prank(vault);
        strategy.settle();

        // Vault gets back more than supplied (yield!)
        uint256 vaultBalAfter = usdc.balanceOf(vault);
        uint256 returned = vaultBalAfter - vaultBalBefore;
        assertGt(returned, SUPPLY_AMOUNT);
        assertEq(returned, SUPPLY_AMOUNT + (SUPPLY_AMOUNT * 200) / 10000); // 2% yield
    }

    function test_settle_onlyVault() public {
        _executeStrategy();

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
        _executeStrategy();

        // Simulate loss: Mamo returns less than minRedeemAmount
        // Burn tokens from the Mamo strategy to simulate loss
        address mamoStrategy = strategy.mamoStrategy();
        uint256 mamoBalance = usdc.balanceOf(mamoStrategy);
        // Burn enough so returned < minRedeemAmount (49_900e6)
        usdc.burn(mamoStrategy, mamoBalance - 40_000e6);

        vm.prank(vault);
        vm.expectRevert(MamoYieldStrategy.InvalidAmount.selector);
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
        _executeStrategy();

        // Now can update
        vm.prank(proposer);
        strategy.updateParams(newParams);
        assertEq(strategy.minRedeemAmount(), 49_800e6);
        assertEq(strategy.supplyAmount(), SUPPLY_AMOUNT); // 0 = don't change
    }

    function test_updateParams_onlyProposer() public {
        _executeStrategy();

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.updateParams(abi.encode(0, 49_800e6));
    }

    function test_updateParams_afterSettled_reverts() public {
        _executeStrategy();

        vm.prank(vault);
        strategy.settle();

        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotExecuted.selector);
        strategy.updateParams(abi.encode(0, 49_800e6));
    }

    function test_updateParams_bothValues() public {
        _executeStrategy();

        vm.prank(proposer);
        strategy.updateParams(abi.encode(60_000e6, 59_000e6));
        assertEq(strategy.supplyAmount(), 60_000e6);
        assertEq(strategy.minRedeemAmount(), 59_000e6);
    }

    // ==================== FULL LIFECYCLE ====================

    function test_fullLifecycle_withParamUpdate() public {
        // 1. Execute
        _executeStrategy();

        // 2. Yield accrues (5%)
        address mamoStrategy = strategy.mamoStrategy();
        MockMamoStrategy(mamoStrategy).setYieldBps(500);
        usdc.mint(mamoStrategy, (SUPPLY_AMOUNT * 500) / 10000);

        // 3. Proposer updates minRedeem to account for yield
        vm.prank(proposer);
        strategy.updateParams(abi.encode(0, 52_000e6)); // expect at least 52k back

        // 4. Settle
        vm.prank(vault);
        strategy.settle();

        // Verify
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
        // Vault got 50_000 * 1.05 = 52_500 back
        assertEq(usdc.balanceOf(vault), 100_000e6 - SUPPLY_AMOUNT + 52_500e6);
    }

    // ==================== CLONING ====================

    function test_clonesHaveIsolatedStorage() public {
        address clone2 = Clones.clone(address(template));
        MamoYieldStrategy strategy2 = MamoYieldStrategy(clone2);

        bytes memory initData2 = abi.encode(address(usdc), address(mamoFactory), 100_000e6, 99_000e6);
        strategy2.initialize(vault, proposer, initData2);

        assertEq(strategy.supplyAmount(), SUPPLY_AMOUNT);
        assertEq(strategy2.supplyAmount(), 100_000e6);
        assertEq(strategy.minRedeemAmount(), MIN_REDEEM);
        assertEq(strategy2.minRedeemAmount(), 99_000e6);
    }

    // ==================== HELPERS ====================

    function _executeStrategy() internal {
        vm.prank(vault);
        usdc.approve(address(strategy), SUPPLY_AMOUNT);
        vm.prank(vault);
        strategy.execute();
    }
}
