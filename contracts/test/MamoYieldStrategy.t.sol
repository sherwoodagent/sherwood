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

/// @notice Mock Mamo strategy that accepts deposit() but doesn't actually pull tokens
contract MockMamoStrategyNoPull {
    function deposit(uint256) external {
        // no-op: doesn't transferFrom, so balance check should fail
    }

    function withdrawAll() external {}
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

/// @notice Mock factory that returns an EOA (non-contract) address
contract MockMamoFactoryReturnsEOA {
    function createStrategyForUser(address) external pure returns (address) {
        return address(0xdead);
    }
}

/// @notice Mock factory that returns a contract that doesn't pull tokens on deposit
contract MockMamoFactoryNoPull {
    address public noPullStrategy;

    constructor() {
        noPullStrategy = address(new MockMamoStrategyNoPull());
    }

    function createStrategyForUser(address) external view returns (address) {
        return noPullStrategy;
    }
}

contract MamoYieldStrategyTest is Test {
    MamoYieldStrategy public template;
    MamoYieldStrategy public strategy;
    ERC20Mock public usdc;
    MockMamoFactory public mamoFactory;

    address public vault = makeAddr("vault");
    address public proposer = makeAddr("proposer");

    uint256 constant VAULT_BALANCE = 100_000e6;
    uint256 constant MIN_REDEEM = 99_000e6;

    function setUp() public {
        usdc = new ERC20Mock("USDC", "USDC", 6);
        mamoFactory = new MockMamoFactory(address(usdc));

        // Fund the vault
        usdc.mint(vault, VAULT_BALANCE);

        // Deploy template and clone
        template = new MamoYieldStrategy();
        address clone = Clones.clone(address(template));
        strategy = MamoYieldStrategy(clone);

        // Initialize — no supplyAmount, taken from vault balance at execute time
        bytes memory initData = abi.encode(address(usdc), address(mamoFactory), MIN_REDEEM, bytes32(0));
        strategy.initialize(vault, proposer, initData);
    }

    // ==================== INITIALIZATION ====================

    function test_initialize() public view {
        assertEq(strategy.vault(), vault);
        assertEq(strategy.proposer(), proposer);
        assertEq(strategy.underlying(), address(usdc));
        assertEq(strategy.mamoFactory(), address(mamoFactory));
        assertEq(strategy.supplyAmount(), 0); // set at execute time
        assertEq(strategy.minRedeemAmount(), MIN_REDEEM);
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Pending));
        assertEq(strategy.name(), "Mamo Yield");
    }

    function test_initialize_twice_reverts() public {
        bytes memory initData = abi.encode(address(usdc), address(mamoFactory), MIN_REDEEM, bytes32(0));
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        strategy.initialize(vault, proposer, initData);
    }

    function test_initialize_zeroVault_reverts() public {
        address clone = Clones.clone(address(template));
        bytes memory initData = abi.encode(address(usdc), address(mamoFactory), MIN_REDEEM, bytes32(0));
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        MamoYieldStrategy(clone).initialize(address(0), proposer, initData);
    }

    function test_initialize_zeroUnderlying_reverts() public {
        address clone = Clones.clone(address(template));
        bytes memory initData = abi.encode(address(0), address(mamoFactory), MIN_REDEEM, bytes32(0));
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        MamoYieldStrategy(clone).initialize(vault, proposer, initData);
    }

    function test_initialize_zeroFactory_reverts() public {
        address clone = Clones.clone(address(template));
        bytes memory initData = abi.encode(address(usdc), address(0), MIN_REDEEM, bytes32(0));
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        MamoYieldStrategy(clone).initialize(vault, proposer, initData);
    }

    // ==================== POSITION VALUE ====================
    // Inherits BaseStrategy's (0, false) default — Mamo has no public
    // balance getter upstream.

    function test_positionValue_alwaysStubbed() public {
        (uint256 value, bool valid) = strategy.positionValue();
        assertEq(value, 0);
        assertFalse(valid);

        vm.prank(vault);
        usdc.approve(address(strategy), VAULT_BALANCE);
        vm.prank(vault);
        strategy.execute();

        (value, valid) = strategy.positionValue();
        assertEq(value, 0);
        assertFalse(valid);
    }

    // ==================== EXECUTE ====================

    function test_execute() public {
        vm.prank(vault);
        usdc.approve(address(strategy), VAULT_BALANCE);

        vm.prank(vault);
        strategy.execute();

        // Mamo strategy created and funded with entire vault balance
        address mamoStrategy = strategy.mamoStrategy();
        assertTrue(mamoStrategy != address(0));
        assertEq(usdc.balanceOf(mamoStrategy), VAULT_BALANCE);
        assertEq(usdc.balanceOf(vault), 0);
        assertEq(strategy.supplyAmount(), VAULT_BALANCE); // recorded at execute time
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
        usdc.approve(address(strategy), VAULT_BALANCE);
        vm.prank(vault);
        strategy.execute();

        vm.prank(vault);
        vm.expectRevert(BaseStrategy.AlreadyExecuted.selector);
        strategy.execute();
    }

    function test_execute_zeroBalance_reverts() public {
        // Drain vault first
        vm.prank(vault);
        usdc.transfer(address(1), VAULT_BALANCE);

        vm.prank(vault);
        vm.expectRevert(MamoYieldStrategy.InvalidAmount.selector);
        strategy.execute();
    }

    // ==================== SETTLE ====================

    function test_settle() public {
        _executeStrategy();

        uint256 vaultBalBefore = usdc.balanceOf(vault);

        vm.prank(vault);
        strategy.settle();

        uint256 vaultBalAfter = usdc.balanceOf(vault);
        assertEq(vaultBalAfter, vaultBalBefore + VAULT_BALANCE);
        assertEq(usdc.balanceOf(strategy.mamoStrategy()), 0);
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
    }

    function test_settle_withYield() public {
        _executeStrategy();

        // Simulate 2% yield
        address mamoStrategy = strategy.mamoStrategy();
        MockMamoStrategy(mamoStrategy).setYieldBps(200);
        usdc.mint(mamoStrategy, (VAULT_BALANCE * 200) / 10000);

        uint256 vaultBalBefore = usdc.balanceOf(vault);

        vm.prank(vault);
        strategy.settle();

        uint256 returned = usdc.balanceOf(vault) - vaultBalBefore;
        assertGt(returned, VAULT_BALANCE);
        assertEq(returned, VAULT_BALANCE + (VAULT_BALANCE * 200) / 10000);
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

        // Simulate loss below minRedeemAmount
        address mamoStrategy = strategy.mamoStrategy();
        uint256 mamoBalance = usdc.balanceOf(mamoStrategy);
        usdc.burn(mamoStrategy, mamoBalance - 40_000e6);

        vm.prank(vault);
        vm.expectRevert(MamoYieldStrategy.InvalidAmount.selector);
        strategy.settle();
    }

    // ==================== UPDATE PARAMS (disabled) ====================

    function test_updateParams_reverts() public {
        _executeStrategy();

        // No tunable params — always reverts
        vm.prank(proposer);
        vm.expectRevert(MamoYieldStrategy.NoTunableParams.selector);
        strategy.updateParams(abi.encode(uint256(0)));
    }

    // ==================== FULL LIFECYCLE ====================

    function test_fullLifecycle_withYield() public {
        // 1. Execute — pulls entire vault balance
        _executeStrategy();
        assertEq(strategy.supplyAmount(), VAULT_BALANCE);

        // 2. Yield accrues (5%)
        address mamoStrategy = strategy.mamoStrategy();
        MockMamoStrategy(mamoStrategy).setYieldBps(500);
        usdc.mint(mamoStrategy, (VAULT_BALANCE * 500) / 10000);

        // 3. Settle
        vm.prank(vault);
        strategy.settle();

        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
        assertEq(usdc.balanceOf(vault), VAULT_BALANCE + (VAULT_BALANCE * 500) / 10000);
    }

    // ==================== CLONING ====================

    function test_clonesHaveIsolatedStorage() public {
        address clone2 = Clones.clone(address(template));
        MamoYieldStrategy strategy2 = MamoYieldStrategy(clone2);

        bytes memory initData2 = abi.encode(address(usdc), address(mamoFactory), 50_000e6, bytes32(0));
        strategy2.initialize(vault, proposer, initData2);

        assertEq(strategy.minRedeemAmount(), MIN_REDEEM);
        assertEq(strategy2.minRedeemAmount(), 50_000e6);
    }

    // ==================== VALIDATION (extcodesize + post-deposit) ====================

    function test_execute_factoryReturnsEOA_reverts() public {
        // Deploy a clone with factory that returns an EOA
        MockMamoFactoryReturnsEOA badFactory = new MockMamoFactoryReturnsEOA();
        address clone = Clones.clone(address(template));
        MamoYieldStrategy badStrategy = MamoYieldStrategy(clone);
        badStrategy.initialize(vault, proposer, abi.encode(address(usdc), address(badFactory), MIN_REDEEM, bytes32(0)));

        vm.prank(vault);
        usdc.approve(address(badStrategy), VAULT_BALANCE);

        vm.prank(vault);
        vm.expectRevert(MamoYieldStrategy.CreateStrategyFailed.selector);
        badStrategy.execute();
    }

    function test_execute_depositNoPull_reverts() public {
        // Deploy a clone with factory whose strategy doesn't pull tokens
        MockMamoFactoryNoPull badFactory = new MockMamoFactoryNoPull();
        address clone = Clones.clone(address(template));
        MamoYieldStrategy badStrategy = MamoYieldStrategy(clone);
        badStrategy.initialize(vault, proposer, abi.encode(address(usdc), address(badFactory), MIN_REDEEM, bytes32(0)));

        vm.prank(vault);
        usdc.approve(address(badStrategy), VAULT_BALANCE);

        vm.prank(vault);
        vm.expectRevert(MamoYieldStrategy.DepositFailed.selector);
        badStrategy.execute();
    }

    function test_execute_unallowedCodehash_reverts() public {
        address clone = Clones.clone(address(template));
        MamoYieldStrategy pinnedStrategy = MamoYieldStrategy(clone);
        // Pin a bogus codehash that won't match whatever the mamoFactory returns.
        bytes32 bogusHash = keccak256("not the real codehash");
        pinnedStrategy.initialize(
            vault, proposer, abi.encode(address(usdc), address(mamoFactory), MIN_REDEEM, bogusHash)
        );

        vm.prank(vault);
        usdc.approve(address(pinnedStrategy), VAULT_BALANCE);

        vm.prank(vault);
        vm.expectRevert(MamoYieldStrategy.UntrustedMamoStrategy.selector);
        pinnedStrategy.execute();
    }

    // ==================== HELPERS ====================

    function _executeStrategy() internal {
        vm.prank(vault);
        usdc.approve(address(strategy), VAULT_BALANCE);
        vm.prank(vault);
        strategy.execute();
    }
}
