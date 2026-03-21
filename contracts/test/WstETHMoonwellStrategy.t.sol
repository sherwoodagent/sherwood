// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {WstETHMoonwellStrategy, IAeroRouter} from "../src/strategies/WstETHMoonwellStrategy.sol";
import {ICToken} from "../src/interfaces/ICToken.sol";
import {BaseStrategy} from "../src/strategies/BaseStrategy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @notice Mock Aerodrome Router — returns tokens at a fixed rate
contract MockAeroRouter {
    // rate scaled by 1e18
    mapping(bytes32 => uint256) public rates;

    function setRate(address tokenIn, address tokenOut, uint256 rate) external {
        rates[keccak256(abi.encodePacked(tokenIn, tokenOut))] = rate;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        IAeroRouter.Route[] calldata routes,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        require(routes.length == 1, "MockAeroRouter: single hop only");

        uint256 rate = rates[keccak256(abi.encodePacked(routes[0].from, routes[0].to))];
        require(rate > 0, "MockAeroRouter: no rate set");

        uint256 amountOut = (amountIn * rate) / 1e18;
        require(amountOut >= amountOutMin, "MockAeroRouter: insufficient output");

        IERC20(routes[0].from).transferFrom(msg.sender, address(this), amountIn);
        ERC20Mock(routes[0].to).mint(to, amountOut);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }
}

/// @notice Mock Moonwell cToken for wstETH
contract MockMwstETH {
    IERC20 public underlying;
    mapping(address => uint256) public balanceOf;
    uint256 public exchangeRate; // scaled by 1e18

    constructor(address underlying_) {
        underlying = IERC20(underlying_);
        exchangeRate = 1e18;
    }

    function setExchangeRate(uint256 rate) external {
        exchangeRate = rate;
    }

    function mint(uint256 mintAmount) external returns (uint256) {
        underlying.transferFrom(msg.sender, address(this), mintAmount);
        uint256 mTokens = (mintAmount * 1e18) / exchangeRate;
        balanceOf[msg.sender] += mTokens;
        return 0; // success
    }

    function redeem(uint256 redeemTokens) external returns (uint256) {
        require(balanceOf[msg.sender] >= redeemTokens, "insufficient mTokens");
        balanceOf[msg.sender] -= redeemTokens;
        uint256 underlyingAmount = (redeemTokens * exchangeRate) / 1e18;
        ERC20Mock(address(underlying)).mint(msg.sender, underlyingAmount);
        return 0; // success
    }
}

/// @notice Mock cToken that always fails mint
contract MockFailingMint {
    function mint(uint256) external pure returns (uint256) {
        return 1; // non-zero = failure
    }

    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function redeem(uint256) external pure returns (uint256) {
        return 0;
    }
}

/// @notice Mock cToken that always fails redeem
contract MockFailingRedeem {
    mapping(address => uint256) public balanceOf;

    function mint(uint256 mintAmount) external returns (uint256) {
        balanceOf[msg.sender] += mintAmount;
        IERC20(msg.sender); // silence unused warning
        return 0;
    }

    function redeem(uint256) external pure returns (uint256) {
        return 1; // non-zero = failure
    }
}

contract WstETHMoonwellStrategyTest is Test {
    WstETHMoonwellStrategy public template;
    WstETHMoonwellStrategy public strategy;

    ERC20Mock public wethToken;
    ERC20Mock public wstethToken;
    MockMwstETH public mwstethToken;
    MockAeroRouter public aeroRouterMock;

    address public vault = makeAddr("vault");
    address public proposer = makeAddr("proposer");
    address public aeroFactory = makeAddr("aeroFactory");

    uint256 constant SUPPLY_AMOUNT = 25e18; // 25 WETH
    // WETH → wstETH ~0.85: 25 WETH → ~21.25 wstETH
    uint256 constant MIN_WSTETH_OUT = 20e18;
    // Settle: ~21.25 wstETH → ~25 WETH
    uint256 constant MIN_WETH_OUT = 24e18;
    uint256 constant DEADLINE_OFFSET = 300;

    // Mock rates (scaled by 1e18)
    // WETH → wstETH: 1 WETH = 0.85 wstETH
    uint256 constant WETH_WSTETH_RATE = 0.85e18;
    // wstETH → WETH: 1 wstETH = 1/0.85 WETH ≈ 1.1765 WETH
    uint256 constant WSTETH_WETH_RATE = 1.1765e18;

    function setUp() public {
        // Deploy mock tokens
        wethToken = new ERC20Mock("WETH", "WETH", 18);
        wstethToken = new ERC20Mock("wstETH", "wstETH", 18);
        mwstethToken = new MockMwstETH(address(wstethToken));

        // Deploy mock router
        aeroRouterMock = new MockAeroRouter();

        // Set swap rates
        aeroRouterMock.setRate(address(wethToken), address(wstethToken), WETH_WSTETH_RATE);
        aeroRouterMock.setRate(address(wstethToken), address(wethToken), WSTETH_WETH_RATE);

        // Fund the vault with WETH
        wethToken.mint(vault, 100e18);

        // Deploy template and clone
        template = new WstETHMoonwellStrategy();
        address clone = Clones.clone(address(template));
        strategy = WstETHMoonwellStrategy(clone);

        // Initialize
        WstETHMoonwellStrategy.InitParams memory params = WstETHMoonwellStrategy.InitParams({
            weth: address(wethToken),
            wsteth: address(wstethToken),
            mwsteth: address(mwstethToken),
            aeroRouter: address(aeroRouterMock),
            aeroFactory: aeroFactory,
            supplyAmount: SUPPLY_AMOUNT,
            minWstethOut: MIN_WSTETH_OUT,
            minWethOut: MIN_WETH_OUT,
            deadlineOffset: DEADLINE_OFFSET
        });
        strategy.initialize(vault, proposer, abi.encode(params));
    }

    // ==================== INITIALIZATION ====================

    function test_initialize() public view {
        assertEq(strategy.vault(), vault);
        assertEq(strategy.proposer(), proposer);
        assertEq(strategy.weth(), address(wethToken));
        assertEq(strategy.wsteth(), address(wstethToken));
        assertEq(strategy.mwsteth(), address(mwstethToken));
        assertEq(strategy.aeroRouter(), address(aeroRouterMock));
        assertEq(strategy.aeroFactory(), aeroFactory);
        assertEq(strategy.supplyAmount(), SUPPLY_AMOUNT);
        assertEq(strategy.minWstethOut(), MIN_WSTETH_OUT);
        assertEq(strategy.minWethOut(), MIN_WETH_OUT);
        assertEq(strategy.deadlineOffset(), DEADLINE_OFFSET);
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Pending));
        assertEq(strategy.name(), "wstETH Moonwell Yield");
    }

    function test_initialize_defaultDeadlineOffset() public {
        address clone = Clones.clone(address(template));
        WstETHMoonwellStrategy s = WstETHMoonwellStrategy(clone);
        WstETHMoonwellStrategy.InitParams memory params = _defaultParams();
        params.deadlineOffset = 0; // should default to 300
        s.initialize(vault, proposer, abi.encode(params));
        assertEq(s.deadlineOffset(), 300);
    }

    function test_initialize_twice_reverts() public {
        WstETHMoonwellStrategy.InitParams memory params = _defaultParams();
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        strategy.initialize(vault, proposer, abi.encode(params));
    }

    function test_initialize_zeroVault_reverts() public {
        address clone = Clones.clone(address(template));
        WstETHMoonwellStrategy.InitParams memory params = _defaultParams();
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        WstETHMoonwellStrategy(clone).initialize(address(0), proposer, abi.encode(params));
    }

    function test_initialize_zeroTokenAddress_reverts() public {
        WstETHMoonwellStrategy.InitParams memory params = _defaultParams();
        params.weth = address(0);
        address clone = Clones.clone(address(template));
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        WstETHMoonwellStrategy(clone).initialize(vault, proposer, abi.encode(params));
    }

    function test_initialize_zeroRouterAddress_reverts() public {
        WstETHMoonwellStrategy.InitParams memory params = _defaultParams();
        params.aeroRouter = address(0);
        address clone = Clones.clone(address(template));
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        WstETHMoonwellStrategy(clone).initialize(vault, proposer, abi.encode(params));
    }

    function test_initialize_zeroSupplyAmount_reverts() public {
        WstETHMoonwellStrategy.InitParams memory params = _defaultParams();
        params.supplyAmount = 0;
        address clone = Clones.clone(address(template));
        vm.expectRevert(WstETHMoonwellStrategy.InvalidAmount.selector);
        WstETHMoonwellStrategy(clone).initialize(vault, proposer, abi.encode(params));
    }

    function test_initialize_zeroSlippage_reverts() public {
        WstETHMoonwellStrategy.InitParams memory params = _defaultParams();
        params.minWstethOut = 0;
        address clone = Clones.clone(address(template));
        vm.expectRevert(WstETHMoonwellStrategy.InvalidAmount.selector);
        WstETHMoonwellStrategy(clone).initialize(vault, proposer, abi.encode(params));
    }

    // ==================== EXECUTE ====================

    function test_execute() public {
        // Vault approves strategy
        vm.prank(vault);
        wethToken.approve(address(strategy), SUPPLY_AMOUNT);

        // Vault calls execute
        vm.prank(vault);
        strategy.execute();

        // Verify: WETH pulled from vault
        assertEq(wethToken.balanceOf(vault), 100e18 - SUPPLY_AMOUNT);

        // Verify: mwstETH minted to strategy
        // 25 WETH → 21.25 wstETH → 21.25e18 mwstETH (1:1 exchange rate)
        uint256 expectedWsteth = (SUPPLY_AMOUNT * WETH_WSTETH_RATE) / 1e18;
        assertEq(mwstethToken.balanceOf(address(strategy)), expectedWsteth);

        // Verify state
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Executed));
        assertTrue(strategy.executed());

        // No dust left on strategy
        assertEq(wethToken.balanceOf(address(strategy)), 0);
        assertEq(wstethToken.balanceOf(address(strategy)), 0);
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

        uint256 vaultBalBefore = wethToken.balanceOf(vault);

        // Settle
        vm.prank(vault);
        strategy.settle();

        // Verify WETH returned to vault
        uint256 vaultBalAfter = wethToken.balanceOf(vault);
        uint256 returned = vaultBalAfter - vaultBalBefore;

        // Due to wstETH/WETH rate round-trip, expect slight difference
        // 25 WETH → 21.25 wstETH → 21.25 wstETH (1:1 mToken) → ~24.999 WETH
        assertGe(returned, MIN_WETH_OUT);
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));

        // No tokens left on strategy
        assertEq(wethToken.balanceOf(address(strategy)), 0);
        assertEq(wstethToken.balanceOf(address(strategy)), 0);
    }

    function test_settle_withYield() public {
        _executeStrategy();

        // Simulate Moonwell yield: exchange rate goes up 5%
        mwstethToken.setExchangeRate(1.05e18);

        uint256 vaultBalBefore = wethToken.balanceOf(vault);

        vm.prank(vault);
        strategy.settle();

        uint256 returned = wethToken.balanceOf(vault) - vaultBalBefore;
        // With 5% yield on wstETH, we get more back
        assertGt(returned, MIN_WETH_OUT);
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

    function test_settle_minWethEnforced() public {
        _executeStrategy();

        // Crash the wstETH→WETH rate so we get less than minWethOut
        aeroRouterMock.setRate(address(wstethToken), address(wethToken), 0.5e18);

        vm.prank(vault);
        vm.expectRevert(); // will revert from either router slippage or our check
        strategy.settle();
    }

    function test_settle_mintFailed_reverts() public {
        // Deploy strategy with a failing mToken
        MockFailingMint failingMint = new MockFailingMint();
        WstETHMoonwellStrategy.InitParams memory params = _defaultParams();
        params.mwsteth = address(failingMint);

        address clone = Clones.clone(address(template));
        WstETHMoonwellStrategy s = WstETHMoonwellStrategy(clone);
        s.initialize(vault, proposer, abi.encode(params));

        vm.prank(vault);
        wethToken.approve(address(s), SUPPLY_AMOUNT);

        vm.prank(vault);
        vm.expectRevert(WstETHMoonwellStrategy.MintFailed.selector);
        s.execute();
    }

    function test_settle_redeemFailed_reverts() public {
        // Deploy a strategy with MockFailingRedeem as mwsteth
        MockFailingRedeem failingRedeem = new MockFailingRedeem();
        WstETHMoonwellStrategy.InitParams memory params = _defaultParams();
        params.mwsteth = address(failingRedeem);

        address clone = Clones.clone(address(template));
        WstETHMoonwellStrategy s = WstETHMoonwellStrategy(clone);
        s.initialize(vault, proposer, abi.encode(params));

        // Execute: vault approves and calls execute
        // MockFailingRedeem.mint succeeds (returns 0) and tracks balance
        vm.prank(vault);
        wethToken.approve(address(s), SUPPLY_AMOUNT);

        // The execute will swap WETH→wstETH, then try to mint on failingRedeem
        // failingRedeem.mint doesn't consume wstETH (no transferFrom), so we need
        // to give it a balance. Actually, MockFailingRedeem.mint just increments balanceOf
        // but doesn't transferFrom. The strategy calls forceApprove then ICToken.mint
        // which tries to call mint(wstethReceived). MockFailingRedeem.mint returns 0
        // (success) and sets balanceOf[msg.sender] += mintAmount. But it doesn't
        // actually take the wstETH. That's fine — the strategy will have wstETH dust
        // that gets pushed back. The key is that balanceOf > 0 so redeem is attempted.
        vm.prank(vault);
        s.execute();

        // Verify failingRedeem has balance recorded for the strategy
        assertGt(failingRedeem.balanceOf(address(s)), 0);

        // Now settle should fail because redeem returns 1
        vm.prank(vault);
        vm.expectRevert(WstETHMoonwellStrategy.RedeemFailed.selector);
        s.settle();
    }

    // ==================== PARAM UPDATES ====================

    function test_updateParams() public {
        _executeStrategy();

        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint256(22e18), uint256(18e18), uint256(600)));

        assertEq(strategy.minWethOut(), 22e18);
        assertEq(strategy.minWstethOut(), 18e18);
        assertEq(strategy.deadlineOffset(), 600);
    }

    function test_updateParams_keepCurrent() public {
        _executeStrategy();

        // Pass 0 to keep current values
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint256(0), uint256(0), uint256(0)));

        assertEq(strategy.minWethOut(), MIN_WETH_OUT);
        assertEq(strategy.minWstethOut(), MIN_WSTETH_OUT);
        assertEq(strategy.deadlineOffset(), DEADLINE_OFFSET);
    }

    function test_updateParams_onlyWhenExecuted() public {
        bytes memory newParams = abi.encode(uint256(22e18), uint256(18e18), uint256(600));

        // Can't update in Pending state
        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotExecuted.selector);
        strategy.updateParams(newParams);
    }

    function test_updateParams_onlyProposer() public {
        _executeStrategy();

        vm.prank(makeAddr("attacker"));
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.updateParams(abi.encode(uint256(22e18), uint256(18e18), uint256(600)));
    }

    function test_updateParams_afterSettled_reverts() public {
        _executeStrategy();

        vm.prank(vault);
        strategy.settle();

        vm.prank(proposer);
        vm.expectRevert(BaseStrategy.NotExecuted.selector);
        strategy.updateParams(abi.encode(uint256(22e18), uint256(18e18), uint256(600)));
    }

    // ==================== FULL LIFECYCLE ====================

    function test_fullLifecycle_withParamUpdate() public {
        // 1. Execute
        _executeStrategy();

        // 2. Moonwell yield accrues (3%)
        mwstethToken.setExchangeRate(1.03e18);

        // 3. Proposer updates slippage
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint256(24e18), uint256(0), uint256(0)));

        // 4. Settle
        vm.prank(vault);
        strategy.settle();

        // Verify lifecycle complete
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
        uint256 vaultBal = wethToken.balanceOf(vault);
        assertGt(vaultBal, 100e18 - SUPPLY_AMOUNT); // got something back
    }

    // ==================== CLONING ====================

    function test_clonesHaveIsolatedStorage() public {
        address clone2 = Clones.clone(address(template));
        WstETHMoonwellStrategy strategy2 = WstETHMoonwellStrategy(clone2);

        WstETHMoonwellStrategy.InitParams memory params = _defaultParams();
        params.supplyAmount = 50e18;
        params.minWethOut = 48e18;
        strategy2.initialize(vault, proposer, abi.encode(params));

        assertEq(strategy.supplyAmount(), SUPPLY_AMOUNT);
        assertEq(strategy2.supplyAmount(), 50e18);
        assertEq(strategy.minWethOut(), MIN_WETH_OUT);
        assertEq(strategy2.minWethOut(), 48e18);
    }

    // ==================== HELPERS ====================

    function _executeStrategy() internal {
        vm.prank(vault);
        wethToken.approve(address(strategy), SUPPLY_AMOUNT);
        vm.prank(vault);
        strategy.execute();
    }

    function _defaultParams() internal view returns (WstETHMoonwellStrategy.InitParams memory) {
        return WstETHMoonwellStrategy.InitParams({
            weth: address(wethToken),
            wsteth: address(wstethToken),
            mwsteth: address(mwstethToken),
            aeroRouter: address(aeroRouterMock),
            aeroFactory: aeroFactory,
            supplyAmount: SUPPLY_AMOUNT,
            minWstethOut: MIN_WSTETH_OUT,
            minWethOut: MIN_WETH_OUT,
            deadlineOffset: DEADLINE_OFFSET
        });
    }
}

// ==================== FORK TEST ====================

contract WstETHMoonwellStrategyForkTest is Test {
    // Real Base mainnet addresses
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant WSTETH = 0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452;
    address constant MWSTETH = 0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b;
    address constant AERO_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERO_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    WstETHMoonwellStrategy public template;
    WstETHMoonwellStrategy public strategy;

    address public vault = makeAddr("forkVault");
    address public proposer = makeAddr("forkProposer");

    uint256 constant SUPPLY_AMOUNT = 0.01e18; // 0.01 WETH (pool has low liquidity)

    uint256 forkId;

    function setUp() public {
        // Try to create fork; skip if RPC unavailable
        try vm.createSelectFork("https://mainnet.base.org") returns (uint256 id) {
            forkId = id;
        } catch {
            vm.skip(true);
        }

        // Fund vault with WETH via deal
        deal(WETH, vault, 10e18);

        // Deploy template and clone
        template = new WstETHMoonwellStrategy();
        address clone = Clones.clone(address(template));
        strategy = WstETHMoonwellStrategy(clone);

        // Initialize with conservative slippage (5%)
        WstETHMoonwellStrategy.InitParams memory params = WstETHMoonwellStrategy.InitParams({
            weth: WETH,
            wsteth: WSTETH,
            mwsteth: MWSTETH,
            aeroRouter: AERO_ROUTER,
            aeroFactory: AERO_FACTORY,
            supplyAmount: SUPPLY_AMOUNT,
            minWstethOut: (SUPPLY_AMOUNT * 80) / 100, // 20% slippage tolerance for fork
            minWethOut: (SUPPLY_AMOUNT * 80) / 100, // 20% slippage tolerance for fork
            deadlineOffset: 300
        });
        strategy.initialize(vault, proposer, abi.encode(params));
    }

    function test_fork_fullLifecycle() public {
        // Execute: vault approves and calls execute
        vm.prank(vault);
        IERC20(WETH).approve(address(strategy), SUPPLY_AMOUNT);

        vm.prank(vault);
        strategy.execute();

        // Verify state
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Executed));

        // Verify mwstETH was minted
        assertGt(IERC20(MWSTETH).balanceOf(address(strategy)), 0);

        // Verify no WETH/wstETH dust on strategy
        assertEq(IERC20(WETH).balanceOf(address(strategy)), 0);
        assertEq(IERC20(WSTETH).balanceOf(address(strategy)), 0);

        // Settle
        uint256 vaultWethBefore = IERC20(WETH).balanceOf(vault);

        vm.prank(vault);
        strategy.settle();

        uint256 vaultWethAfter = IERC20(WETH).balanceOf(vault);
        uint256 returned = vaultWethAfter - vaultWethBefore;

        // Verify WETH returned (at least 80% due to slippage tolerance)
        assertGt(returned, (SUPPLY_AMOUNT * 80) / 100);

        // Verify final state
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));

        // No tokens left on strategy
        assertEq(IERC20(WETH).balanceOf(address(strategy)), 0);
        assertEq(IERC20(WSTETH).balanceOf(address(strategy)), 0);
    }
}
