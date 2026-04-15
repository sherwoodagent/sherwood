// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {AerodromeLPStrategy, IAeroRouter, IAeroGauge} from "../src/strategies/AerodromeLPStrategy.sol";
import {BaseStrategy} from "../src/strategies/BaseStrategy.sol";
import {IStrategy} from "../src/interfaces/IStrategy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @notice Mock Aerodrome Router — simplified addLiquidity/removeLiquidity
contract MockAeroRouter {
    ERC20Mock public lpToken;

    constructor(address lpToken_) {
        lpToken = ERC20Mock(lpToken_);
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        bool, /* stable */
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256, /* amountAMin */
        uint256, /* amountBMin */
        address to,
        uint256 /* deadline */
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity) {
        IERC20(tokenA).transferFrom(msg.sender, address(this), amountADesired);
        IERC20(tokenB).transferFrom(msg.sender, address(this), amountBDesired);
        liquidity = amountADesired + amountBDesired;
        lpToken.mint(to, liquidity);
        return (amountADesired, amountBDesired, liquidity);
    }

    function removeLiquidity(
        address tokenA,
        address tokenB,
        bool, /* stable */
        uint256 liquidity,
        uint256, /* amountAMin */
        uint256, /* amountBMin */
        address to,
        uint256 /* deadline */
    ) external returns (uint256 amountA, uint256 amountB) {
        lpToken.burn(msg.sender, liquidity);
        amountA = liquidity / 2;
        amountB = liquidity - amountA;
        ERC20Mock(tokenA).mint(to, amountA);
        ERC20Mock(tokenB).mint(to, amountB);
        return (amountA, amountB);
    }
}

/// @notice Mock Aerodrome Gauge — stake LP, earn AERO rewards
contract MockAeroGauge {
    IERC20 public stakingToken;
    ERC20Mock public rewardToken;
    mapping(address => uint256) public balanceOf;
    uint256 public pendingReward; // flat reward amount to give on getReward

    constructor(address stakingToken_, address rewardToken_) {
        stakingToken = IERC20(stakingToken_);
        rewardToken = ERC20Mock(rewardToken_);
    }

    function setPendingReward(uint256 r) external {
        pendingReward = r;
    }

    function deposit(uint256 _amount) external {
        stakingToken.transferFrom(msg.sender, address(this), _amount);
        balanceOf[msg.sender] += _amount;
    }

    function withdraw(uint256 _amount) external {
        balanceOf[msg.sender] -= _amount;
        stakingToken.transfer(msg.sender, _amount);
    }

    function getReward(address _account) external {
        if (pendingReward > 0) {
            rewardToken.mint(_account, pendingReward);
            pendingReward = 0;
        }
    }
}

contract AerodromeLPStrategyTest is Test {
    AerodromeLPStrategy public template;
    AerodromeLPStrategy public strategy;

    ERC20Mock public usdc;
    ERC20Mock public weth;
    ERC20Mock public lpToken;
    ERC20Mock public aero;

    MockAeroRouter public router;
    MockAeroGauge public gauge;

    address public vault = makeAddr("vault");
    address public proposer = makeAddr("proposer");
    address public factory_ = makeAddr("factory");

    uint256 constant AMOUNT_A = 50_000e6;
    uint256 constant AMOUNT_B = 25e18;
    uint256 constant MIN_A = 49_000e6;
    uint256 constant MIN_B = 24e18;

    function setUp() public {
        usdc = new ERC20Mock("USDC", "USDC", 6);
        weth = new ERC20Mock("WETH", "WETH", 18);
        lpToken = new ERC20Mock("vAMM-USDC/WETH", "vAMM", 18);
        aero = new ERC20Mock("AERO", "AERO", 18);

        router = new MockAeroRouter(address(lpToken));
        gauge = new MockAeroGauge(address(lpToken), address(aero));

        usdc.mint(vault, 100_000e6);
        weth.mint(vault, 50e18);

        template = new AerodromeLPStrategy();
        address clone = Clones.clone(address(template));
        strategy = AerodromeLPStrategy(clone);

        strategy.initialize(vault, proposer, _initData(address(gauge)));
    }

    // ── Helpers ──

    function _initData(address gauge_) internal view returns (bytes memory) {
        AerodromeLPStrategy.InitParams memory p = AerodromeLPStrategy.InitParams({
            tokenA: address(usdc),
            tokenB: address(weth),
            stable: false,
            factory: factory_,
            router: address(router),
            gauge: gauge_,
            lpToken: address(lpToken),
            amountADesired: AMOUNT_A,
            amountBDesired: AMOUNT_B,
            amountAMin: MIN_A,
            amountBMin: MIN_B,
            minAmountAOut: MIN_A,
            minAmountBOut: MIN_B
        });
        return abi.encode(p);
    }

    function _executeStrategy() internal {
        vm.startPrank(vault);
        usdc.approve(address(strategy), AMOUNT_A);
        weth.approve(address(strategy), AMOUNT_B);
        strategy.execute();
        vm.stopPrank();
    }

    // ==================== INITIALIZATION ====================

    function test_initialize() public view {
        assertEq(strategy.vault(), vault);
        assertEq(strategy.proposer(), proposer);
        assertEq(strategy.tokenA(), address(usdc));
        assertEq(strategy.tokenB(), address(weth));
        assertFalse(strategy.stable());
        assertEq(strategy.router(), address(router));
        assertEq(strategy.gauge(), address(gauge));
        assertEq(strategy.lpToken(), address(lpToken));
        assertEq(strategy.amountADesired(), AMOUNT_A);
        assertEq(strategy.amountBDesired(), AMOUNT_B);
        assertEq(strategy.name(), "Aerodrome LP");
    }

    function test_initialize_zeroTokens_reverts() public {
        address clone = Clones.clone(address(template));
        AerodromeLPStrategy.InitParams memory p = AerodromeLPStrategy.InitParams({
            tokenA: address(0),
            tokenB: address(weth),
            stable: false,
            factory: factory_,
            router: address(router),
            gauge: address(0),
            lpToken: address(lpToken),
            amountADesired: AMOUNT_A,
            amountBDesired: AMOUNT_B,
            amountAMin: MIN_A,
            amountBMin: MIN_B,
            minAmountAOut: MIN_A,
            minAmountBOut: MIN_B
        });
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        AerodromeLPStrategy(clone).initialize(vault, proposer, abi.encode(p));
    }

    function test_initialize_zeroAmounts_reverts() public {
        address clone = Clones.clone(address(template));
        AerodromeLPStrategy.InitParams memory p = AerodromeLPStrategy.InitParams({
            tokenA: address(usdc),
            tokenB: address(weth),
            stable: false,
            factory: factory_,
            router: address(router),
            gauge: address(0),
            lpToken: address(lpToken),
            amountADesired: 0,
            amountBDesired: 0,
            amountAMin: MIN_A,
            amountBMin: MIN_B,
            minAmountAOut: MIN_A,
            minAmountBOut: MIN_B
        });
        vm.expectRevert(AerodromeLPStrategy.InvalidAmount.selector);
        AerodromeLPStrategy(clone).initialize(vault, proposer, abi.encode(p));
    }

    function test_initialize_gaugeMismatch_reverts() public {
        ERC20Mock wrongLp = new ERC20Mock("WRONG", "WRONG", 18);
        MockAeroGauge badGauge = new MockAeroGauge(address(wrongLp), address(aero));

        address clone = Clones.clone(address(template));
        AerodromeLPStrategy.InitParams memory p = AerodromeLPStrategy.InitParams({
            tokenA: address(usdc),
            tokenB: address(weth),
            stable: false,
            factory: factory_,
            router: address(router),
            gauge: address(badGauge),
            lpToken: address(lpToken),
            amountADesired: AMOUNT_A,
            amountBDesired: AMOUNT_B,
            amountAMin: MIN_A,
            amountBMin: MIN_B,
            minAmountAOut: MIN_A,
            minAmountBOut: MIN_B
        });
        vm.expectRevert(AerodromeLPStrategy.GaugeMismatch.selector);
        AerodromeLPStrategy(clone).initialize(vault, proposer, abi.encode(p));
    }

    // ==================== POSITION VALUE ====================
    // Inherits BaseStrategy's (0, false) default. LP decomposition
    // deferred to a follow-up — see contract comment for rationale.

    function test_positionValue_alwaysStubbed() public {
        (uint256 value, bool valid) = strategy.positionValue();
        assertEq(value, 0);
        assertFalse(valid);

        _executeStrategy();

        (value, valid) = strategy.positionValue();
        assertEq(value, 0);
        assertFalse(valid);
    }

    // ==================== EXECUTE ====================

    function test_execute() public {
        _executeStrategy();

        uint256 expectedLp = AMOUNT_A + AMOUNT_B;
        assertEq(gauge.balanceOf(address(strategy)), expectedLp);
        assertEq(lpToken.balanceOf(address(strategy)), 0); // all staked
        assertEq(usdc.balanceOf(vault), 100_000e6 - AMOUNT_A);
        assertEq(weth.balanceOf(vault), 50e18 - AMOUNT_B);
        assertTrue(strategy.executed());
    }

    function test_execute_onlyVault() public {
        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotVault.selector);
        strategy.execute();
    }

    function test_execute_twice_reverts() public {
        _executeStrategy();

        vm.prank(vault);
        vm.expectRevert(BaseStrategy.AlreadyExecuted.selector);
        strategy.execute();
    }

    // ==================== SETTLE ====================

    function test_settle() public {
        _executeStrategy();

        vm.prank(vault);
        strategy.settle();

        uint256 totalLp = AMOUNT_A + AMOUNT_B;
        uint256 returnedA = totalLp / 2;
        uint256 returnedB = totalLp - returnedA;

        assertEq(usdc.balanceOf(vault), (100_000e6 - AMOUNT_A) + returnedA);
        assertEq(weth.balanceOf(vault), (50e18 - AMOUNT_B) + returnedB);
        assertEq(lpToken.balanceOf(address(strategy)), 0);
        assertEq(gauge.balanceOf(address(strategy)), 0);
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
    }

    function test_settle_withAeroRewards() public {
        _executeStrategy();

        // Set pending reward before settle
        gauge.setPendingReward(100e18); // 100 AERO

        vm.prank(vault);
        strategy.settle();

        // AERO rewards sent to vault
        assertEq(aero.balanceOf(vault), 100e18);
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
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

    // ==================== NO GAUGE ====================

    function test_noGauge_executeAndSettle() public {
        // Deploy without gauge
        address clone = Clones.clone(address(template));
        AerodromeLPStrategy noGauge = AerodromeLPStrategy(clone);
        noGauge.initialize(vault, proposer, _initData(address(0)));

        vm.startPrank(vault);
        usdc.approve(address(noGauge), AMOUNT_A);
        weth.approve(address(noGauge), AMOUNT_B);
        noGauge.execute();
        vm.stopPrank();

        // LP tokens held directly by strategy (not staked)
        uint256 expectedLp = AMOUNT_A + AMOUNT_B;
        assertEq(lpToken.balanceOf(address(noGauge)), expectedLp);

        vm.prank(vault);
        noGauge.settle();

        assertEq(lpToken.balanceOf(address(noGauge)), 0);
        assertEq(uint256(noGauge.state()), uint256(BaseStrategy.State.Settled));
    }

    // ==================== PARAM UPDATES ====================

    function test_updateParams() public {
        _executeStrategy();

        vm.prank(proposer);
        strategy.updateParams(abi.encode(48_000e6, 23e18));

        assertEq(strategy.minAmountAOut(), 48_000e6);
        assertEq(strategy.minAmountBOut(), 23e18);
    }

    function test_updateParams_partialUpdate() public {
        _executeStrategy();

        vm.prank(proposer);
        strategy.updateParams(abi.encode(48_000e6, uint256(0)));

        assertEq(strategy.minAmountAOut(), 48_000e6);
        assertEq(strategy.minAmountBOut(), MIN_B); // unchanged
    }

    function test_updateParams_onlyProposer() public {
        _executeStrategy();

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.updateParams(abi.encode(48_000e6, 23e18));
    }

    function test_updateParams_onlyWhenExecuted() public {
        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotExecuted.selector);
        strategy.updateParams(abi.encode(48_000e6, 23e18));
    }

    // ==================== FULL LIFECYCLE ====================

    function test_fullLifecycle() public {
        _executeStrategy();

        vm.prank(proposer);
        strategy.updateParams(abi.encode(45_000e6, 22e18));

        gauge.setPendingReward(50e18);

        vm.prank(vault);
        strategy.settle();

        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
        assertGt(usdc.balanceOf(vault), 0);
        assertGt(weth.balanceOf(vault), 0);
        assertEq(aero.balanceOf(vault), 50e18);
    }

    // ==================== CLONING ====================

    function test_clonesIsolated() public {
        address clone2 = Clones.clone(address(template));
        AerodromeLPStrategy strategy2 = AerodromeLPStrategy(clone2);

        AerodromeLPStrategy.InitParams memory p = AerodromeLPStrategy.InitParams({
            tokenA: address(usdc),
            tokenB: address(weth),
            stable: true,
            factory: factory_,
            router: address(router),
            gauge: address(gauge),
            lpToken: address(lpToken),
            amountADesired: 100_000e6,
            amountBDesired: 50e18,
            amountAMin: 99_000e6,
            amountBMin: 49e18,
            minAmountAOut: 99_000e6,
            minAmountBOut: 49e18
        });
        strategy2.initialize(vault, proposer, abi.encode(p));

        assertEq(strategy.amountADesired(), AMOUNT_A);
        assertEq(strategy2.amountADesired(), 100_000e6);
        assertFalse(strategy.stable());
        assertTrue(strategy2.stable());
    }
}
