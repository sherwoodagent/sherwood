// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {VeniceInferenceStrategy, IVeniceStaking, IAeroRouter} from "../src/strategies/VeniceInferenceStrategy.sol";
import {BaseStrategy} from "../src/strategies/BaseStrategy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @notice Simplified mock Venice staking — accepts VVV, mints sVVV to recipient. No unstake.
contract MockVeniceStaking is ERC20Mock {
    ERC20Mock public vvvToken;

    constructor(address vvv_) ERC20Mock("Staked VVV", "sVVV", 18) {
        vvvToken = ERC20Mock(vvv_);
    }

    function stake(address recipient, uint256 amount) external {
        vvvToken.transferFrom(msg.sender, address(this), amount);
        _mint(recipient, amount); // 1:1 sVVV
    }
}

/// @notice Mock Aerodrome swap router — pulls input via transferFrom, mints output at a fixed rate
contract MockSwapRouter {
    ERC20Mock public outputToken;
    uint256 public rate; // output per input token (scaled 1e18)

    constructor(address outputToken_, uint256 rate_) {
        outputToken = ERC20Mock(outputToken_);
        rate = rate_;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        IAeroRouter.Route[] calldata routes,
        address to,
        uint256 /* deadline */
    ) external returns (uint256[] memory amounts) {
        // Pull input token from caller (strategy approved router)
        IERC20(routes[0].from).transferFrom(msg.sender, address(this), amountIn);

        uint256 amountOut = (amountIn * rate) / 1e18;
        require(amountOut >= amountOutMin, "Slippage");

        outputToken.mint(to, amountOut);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Test: Direct VVV path (asset == vvv, no swap)
// ═══════════════════════════════════════════════════════════════════════

contract VeniceInferenceStrategy_DirectTest is Test {
    VeniceInferenceStrategy public template;
    VeniceInferenceStrategy public strategy;

    ERC20Mock public vvvToken;
    MockVeniceStaking public sVVVToken;

    address public vault = makeAddr("vault");
    address public proposer = makeAddr("proposer");
    address public agentWallet = makeAddr("agentWallet");

    uint256 constant VVV_AMOUNT = 1000e18;

    function setUp() public {
        vvvToken = new ERC20Mock("VVV", "VVV", 18);
        sVVVToken = new MockVeniceStaking(address(vvvToken));
        vvvToken.mint(vault, 10_000e18);

        template = new VeniceInferenceStrategy();
        address clone = Clones.clone(address(template));
        strategy = VeniceInferenceStrategy(clone);

        VeniceInferenceStrategy.InitParams memory p = VeniceInferenceStrategy.InitParams({
            asset: address(vvvToken), // asset == vvv → direct path
            weth: address(0),
            vvv: address(vvvToken),
            sVVV: address(sVVVToken),
            aeroRouter: address(0),
            aeroFactory: address(0),
            agent: agentWallet,
            assetAmount: VVV_AMOUNT,
            minVVV: 0,
            deadlineOffset: 0,
            singleHop: false
        });
        strategy.initialize(vault, proposer, abi.encode(p));
    }

    // ── Initialization ──

    function test_initialize() public view {
        assertEq(strategy.vault(), vault);
        assertEq(strategy.proposer(), proposer);
        assertEq(strategy.asset(), address(vvvToken));
        assertEq(strategy.vvv(), address(vvvToken));
        assertEq(strategy.sVVV(), address(sVVVToken));
        assertEq(strategy.agent(), agentWallet);
        assertEq(strategy.assetAmount(), VVV_AMOUNT);
        assertEq(strategy.repaymentAmount(), VVV_AMOUNT); // defaults to assetAmount
        assertFalse(strategy.needsSwap());
        assertEq(strategy.stakedAmount(), 0);
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Pending));
        assertEq(strategy.name(), "Venice Inference");
    }

    function test_initialize_twice_reverts() public {
        VeniceInferenceStrategy.InitParams memory p = VeniceInferenceStrategy.InitParams({
            asset: address(vvvToken),
            weth: address(0),
            vvv: address(vvvToken),
            sVVV: address(sVVVToken),
            aeroRouter: address(0),
            aeroFactory: address(0),
            agent: agentWallet,
            assetAmount: VVV_AMOUNT,
            minVVV: 0,
            deadlineOffset: 0,
            singleHop: false
        });
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        strategy.initialize(vault, proposer, abi.encode(p));
    }

    function test_initialize_zeroVVV_reverts() public {
        address clone = Clones.clone(address(template));
        VeniceInferenceStrategy.InitParams memory p = VeniceInferenceStrategy.InitParams({
            asset: address(vvvToken),
            weth: address(0),
            vvv: address(0),
            sVVV: address(sVVVToken),
            aeroRouter: address(0),
            aeroFactory: address(0),
            agent: agentWallet,
            assetAmount: VVV_AMOUNT,
            minVVV: 0,
            deadlineOffset: 0,
            singleHop: false
        });
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        VeniceInferenceStrategy(clone).initialize(vault, proposer, abi.encode(p));
    }

    function test_initialize_zeroAgent_reverts() public {
        address clone = Clones.clone(address(template));
        VeniceInferenceStrategy.InitParams memory p = VeniceInferenceStrategy.InitParams({
            asset: address(vvvToken),
            weth: address(0),
            vvv: address(vvvToken),
            sVVV: address(sVVVToken),
            aeroRouter: address(0),
            aeroFactory: address(0),
            agent: address(0),
            assetAmount: VVV_AMOUNT,
            minVVV: 0,
            deadlineOffset: 0,
            singleHop: false
        });
        vm.expectRevert(VeniceInferenceStrategy.NoAgent.selector);
        VeniceInferenceStrategy(clone).initialize(vault, proposer, abi.encode(p));
    }

    function test_initialize_zeroAmount_reverts() public {
        address clone = Clones.clone(address(template));
        VeniceInferenceStrategy.InitParams memory p = VeniceInferenceStrategy.InitParams({
            asset: address(vvvToken),
            weth: address(0),
            vvv: address(vvvToken),
            sVVV: address(sVVVToken),
            aeroRouter: address(0),
            aeroFactory: address(0),
            agent: agentWallet,
            assetAmount: 0,
            minVVV: 0,
            deadlineOffset: 0,
            singleHop: false
        });
        vm.expectRevert(VeniceInferenceStrategy.InvalidAmount.selector);
        VeniceInferenceStrategy(clone).initialize(vault, proposer, abi.encode(p));
    }

    // ── Position value ──
    // Inherits BaseStrategy's (0, false) default — loan model; no
    // asset held by the strategy mid-execution.

    function test_positionValue_alwaysStubbed() public {
        (uint256 value, bool valid) = strategy.positionValue();
        assertEq(value, 0);
        assertFalse(valid);

        vm.prank(vault);
        vvvToken.approve(address(strategy), VVV_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        (value, valid) = strategy.positionValue();
        assertEq(value, 0);
        assertFalse(valid);
    }

    // ── Execute (direct VVV) ──

    function test_execute() public {
        vm.prank(vault);
        vvvToken.approve(address(strategy), VVV_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        assertEq(vvvToken.balanceOf(vault), 10_000e18 - VVV_AMOUNT);
        assertEq(sVVVToken.balanceOf(agentWallet), VVV_AMOUNT);
        assertEq(strategy.stakedAmount(), VVV_AMOUNT);
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Executed));
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

    // ── Settle (loan-model: agent repays vault in asset) ──

    function test_settle() public {
        _executeStrategy();

        // Agent gets VVV to repay (direct path: asset == VVV)
        vvvToken.mint(agentWallet, VVV_AMOUNT);
        vm.prank(agentWallet);
        vvvToken.approve(address(strategy), VVV_AMOUNT);

        uint256 vaultBalBefore = vvvToken.balanceOf(vault);
        uint256 agentSVVVBefore = sVVVToken.balanceOf(agentWallet);

        vm.prank(vault);
        strategy.settle();

        // Vault received repaymentAmount
        assertEq(vvvToken.balanceOf(vault), vaultBalBefore + VVV_AMOUNT);
        // sVVV stays with agent — unchanged
        assertEq(sVVVToken.balanceOf(agentWallet), agentSVVVBefore);
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
    }

    function test_settle_agentNotApproved_reverts() public {
        _executeStrategy();
        // Agent has balance but hasn't approved
        vvvToken.mint(agentWallet, VVV_AMOUNT);
        vm.prank(vault);
        vm.expectRevert();
        strategy.settle();
    }

    function test_settle_agentInsufficientBalance_reverts() public {
        _executeStrategy();
        // Agent approves but has no balance
        vm.prank(agentWallet);
        vvvToken.approve(address(strategy), VVV_AMOUNT);
        vm.prank(vault);
        vm.expectRevert();
        strategy.settle();
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

    // ── Full Lifecycle (direct) ──

    function test_fullLifecycle() public {
        // 1. Execute — vault lends VVV, agent gets sVVV
        vm.prank(vault);
        vvvToken.approve(address(strategy), VVV_AMOUNT);
        vm.prank(vault);
        strategy.execute();
        assertEq(sVVVToken.balanceOf(agentWallet), VVV_AMOUNT);

        // 2. Agent earns off-chain and gets VVV to repay
        vvvToken.mint(agentWallet, VVV_AMOUNT);
        vm.prank(agentWallet);
        vvvToken.approve(address(strategy), VVV_AMOUNT);

        // 3. Settle — agent repays principal
        uint256 vaultBalBefore = vvvToken.balanceOf(vault);
        vm.prank(vault);
        strategy.settle();

        // Vault recovered principal
        assertEq(vvvToken.balanceOf(vault), vaultBalBefore + VVV_AMOUNT);
        // sVVV stays with agent permanently
        assertEq(sVVVToken.balanceOf(agentWallet), VVV_AMOUNT);
    }

    function test_fullLifecycle_withProfit() public {
        // 1. Execute
        vm.prank(vault);
        vvvToken.approve(address(strategy), VVV_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        // 2. Agent updates repayment to include profit (120% of principal)
        uint256 repayment = VVV_AMOUNT * 120 / 100;
        vm.prank(proposer);
        strategy.updateParams(abi.encode(repayment, uint256(0), uint256(0)));
        assertEq(strategy.repaymentAmount(), repayment);

        // 3. Agent gets funds and approves
        vvvToken.mint(agentWallet, repayment);
        vm.prank(agentWallet);
        vvvToken.approve(address(strategy), repayment);

        // 4. Settle
        uint256 vaultBalBefore = vvvToken.balanceOf(vault);
        vm.prank(vault);
        strategy.settle();

        // Vault received more than principal
        assertEq(vvvToken.balanceOf(vault), vaultBalBefore + repayment);
        assertGt(repayment, VVV_AMOUNT);
        // sVVV stays with agent
        assertEq(sVVVToken.balanceOf(agentWallet), VVV_AMOUNT);
    }

    // ── Cloning ──

    function test_clonesHaveIsolatedStorage() public {
        address clone2 = Clones.clone(address(template));
        VeniceInferenceStrategy strategy2 = VeniceInferenceStrategy(clone2);

        address agent2 = makeAddr("agent2");
        VeniceInferenceStrategy.InitParams memory p = VeniceInferenceStrategy.InitParams({
            asset: address(vvvToken),
            weth: address(0),
            vvv: address(vvvToken),
            sVVV: address(sVVVToken),
            aeroRouter: address(0),
            aeroFactory: address(0),
            agent: agent2,
            assetAmount: 2_000e18,
            minVVV: 0,
            deadlineOffset: 0,
            singleHop: false
        });
        strategy2.initialize(vault, proposer, abi.encode(p));

        assertEq(strategy.agent(), agentWallet);
        assertEq(strategy2.agent(), agent2);
        assertEq(strategy.assetAmount(), VVV_AMOUNT);
        assertEq(strategy2.assetAmount(), 2_000e18);
        assertEq(strategy.repaymentAmount(), VVV_AMOUNT);
        assertEq(strategy2.repaymentAmount(), 2_000e18);
    }

    // ── Helpers ──

    function _executeStrategy() internal {
        vm.prank(vault);
        vvvToken.approve(address(strategy), VVV_AMOUNT);
        vm.prank(vault);
        strategy.execute();
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Test: Swap path (asset != vvv, Aerodrome swap)
// ═══════════════════════════════════════════════════════════════════════

contract VeniceInferenceStrategy_SwapTest is Test {
    VeniceInferenceStrategy public template;
    VeniceInferenceStrategy public strategy;

    ERC20Mock public usdc;
    ERC20Mock public vvvToken;
    MockVeniceStaking public sVVVToken;
    MockSwapRouter public swapRouter;

    address public vault = makeAddr("vault");
    address public proposer = makeAddr("proposer");
    address public agentWallet = makeAddr("agentWallet");
    address public aeroFactory = makeAddr("aeroFactory");

    uint256 constant USDC_AMOUNT = 500e6; // 500 USDC
    uint256 constant MIN_VVV = 900e18; // slippage floor
    uint256 constant SWAP_RATE = 2e30; // accounts for 6→18 decimal gap: 500e6 * 2e30 / 1e18 = 1000e18

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        vvvToken = new ERC20Mock("VVV", "VVV", 18);
        sVVVToken = new MockVeniceStaking(address(vvvToken));
        swapRouter = new MockSwapRouter(address(vvvToken), SWAP_RATE);

        usdc.mint(vault, 10_000e6);

        template = new VeniceInferenceStrategy();
        address clone = Clones.clone(address(template));
        strategy = VeniceInferenceStrategy(clone);

        VeniceInferenceStrategy.InitParams memory p = VeniceInferenceStrategy.InitParams({
            asset: address(usdc),
            weth: address(0),
            vvv: address(vvvToken),
            sVVV: address(sVVVToken),
            aeroRouter: address(swapRouter),
            aeroFactory: aeroFactory,
            agent: agentWallet,
            assetAmount: USDC_AMOUNT,
            minVVV: MIN_VVV,
            deadlineOffset: 300,
            singleHop: true
        });
        strategy.initialize(vault, proposer, abi.encode(p));
    }

    // ── Initialization (swap-specific) ──

    function test_initialize_swap() public view {
        assertEq(strategy.asset(), address(usdc));
        assertEq(strategy.vvv(), address(vvvToken));
        assertTrue(strategy.needsSwap());
        assertEq(strategy.assetAmount(), USDC_AMOUNT);
        assertEq(strategy.repaymentAmount(), USDC_AMOUNT); // defaults to assetAmount
        assertEq(strategy.minVVV(), MIN_VVV);
        assertEq(strategy.deadlineOffset(), 300);
        assertTrue(strategy.singleHop());
    }

    function test_initialize_swap_noMinVVV_reverts() public {
        address clone = Clones.clone(address(template));
        VeniceInferenceStrategy.InitParams memory p = VeniceInferenceStrategy.InitParams({
            asset: address(usdc),
            weth: address(0),
            vvv: address(vvvToken),
            sVVV: address(sVVVToken),
            aeroRouter: address(swapRouter),
            aeroFactory: aeroFactory,
            agent: agentWallet,
            assetAmount: USDC_AMOUNT,
            minVVV: 0, // must be > 0 for swap path
            deadlineOffset: 300,
            singleHop: true
        });
        vm.expectRevert(VeniceInferenceStrategy.InvalidAmount.selector);
        VeniceInferenceStrategy(clone).initialize(vault, proposer, abi.encode(p));
    }

    function test_initialize_swap_noRouter_reverts() public {
        address clone = Clones.clone(address(template));
        VeniceInferenceStrategy.InitParams memory p = VeniceInferenceStrategy.InitParams({
            asset: address(usdc),
            weth: address(0),
            vvv: address(vvvToken),
            sVVV: address(sVVVToken),
            aeroRouter: address(0), // missing router
            aeroFactory: aeroFactory,
            agent: agentWallet,
            assetAmount: USDC_AMOUNT,
            minVVV: MIN_VVV,
            deadlineOffset: 300,
            singleHop: true
        });
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        VeniceInferenceStrategy(clone).initialize(vault, proposer, abi.encode(p));
    }

    function test_initialize_multiHop_noWeth_reverts() public {
        address clone = Clones.clone(address(template));
        VeniceInferenceStrategy.InitParams memory p = VeniceInferenceStrategy.InitParams({
            asset: address(usdc),
            weth: address(0), // missing WETH for multi-hop
            vvv: address(vvvToken),
            sVVV: address(sVVVToken),
            aeroRouter: address(swapRouter),
            aeroFactory: aeroFactory,
            agent: agentWallet,
            assetAmount: USDC_AMOUNT,
            minVVV: MIN_VVV,
            deadlineOffset: 300,
            singleHop: false // multi-hop needs WETH
        });
        vm.expectRevert(BaseStrategy.ZeroAddress.selector);
        VeniceInferenceStrategy(clone).initialize(vault, proposer, abi.encode(p));
    }

    // ── Execute (swap path) ──

    function test_execute_swap() public {
        vm.prank(vault);
        usdc.approve(address(strategy), USDC_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        // Mock gives 2 VVV per USDC unit (rate accounts for decimal gap)
        uint256 expectedVVV = (USDC_AMOUNT * SWAP_RATE) / 1e18;

        assertEq(sVVVToken.balanceOf(agentWallet), expectedVVV);
        assertEq(strategy.stakedAmount(), expectedVVV);
        assertTrue(strategy.executed());
    }

    function test_execute_multiHop() public {
        // Deploy a multi-hop strategy: USDC → WETH → VVV
        ERC20Mock wethToken = new ERC20Mock("WETH", "WETH", 18);
        address clone2 = Clones.clone(address(template));
        VeniceInferenceStrategy multiHop = VeniceInferenceStrategy(clone2);

        VeniceInferenceStrategy.InitParams memory p = VeniceInferenceStrategy.InitParams({
            asset: address(usdc),
            weth: address(wethToken),
            vvv: address(vvvToken),
            sVVV: address(sVVVToken),
            aeroRouter: address(swapRouter),
            aeroFactory: aeroFactory,
            agent: agentWallet,
            assetAmount: USDC_AMOUNT,
            minVVV: MIN_VVV,
            deadlineOffset: 300,
            singleHop: false // multi-hop
        });
        multiHop.initialize(vault, proposer, abi.encode(p));

        assertFalse(multiHop.singleHop());
        assertTrue(multiHop.needsSwap());

        // Execute
        vm.prank(vault);
        usdc.approve(address(multiHop), USDC_AMOUNT);
        vm.prank(vault);
        multiHop.execute();

        // Mock router still produces same output (rate-based)
        uint256 expectedVVV = (USDC_AMOUNT * SWAP_RATE) / 1e18;
        assertEq(sVVVToken.balanceOf(agentWallet), expectedVVV);
        assertEq(multiHop.stakedAmount(), expectedVVV);
    }

    // ── Settle (swap path: agent repays in ORIGINAL asset, e.g. USDC) ──

    function test_settle_swapPath() public {
        _executeStrategy();

        uint256 agentSVVVAfterExec = sVVVToken.balanceOf(agentWallet);

        // Agent gets USDC to repay (repays in vault's asset, not VVV)
        usdc.mint(agentWallet, USDC_AMOUNT);
        vm.prank(agentWallet);
        usdc.approve(address(strategy), USDC_AMOUNT);

        uint256 vaultUsdcBefore = usdc.balanceOf(vault);

        vm.prank(vault);
        strategy.settle();

        // Vault received repaymentAmount in USDC
        assertEq(usdc.balanceOf(vault), vaultUsdcBefore + USDC_AMOUNT);
        // sVVV stays with agent — unchanged
        assertEq(sVVVToken.balanceOf(agentWallet), agentSVVVAfterExec);
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
    }

    // ── updateParams (3 fields) ──

    function test_updateParams() public {
        _executeStrategy();

        uint256 newRepayment = 600e6;
        uint256 newMinVVV = 500e18;
        uint256 newDeadlineOffset = 600;

        vm.prank(proposer);
        strategy.updateParams(abi.encode(newRepayment, newMinVVV, newDeadlineOffset));

        assertEq(strategy.repaymentAmount(), newRepayment);
        assertEq(strategy.minVVV(), newMinVVV);
        assertEq(strategy.deadlineOffset(), newDeadlineOffset);
    }

    function test_updateParams_onlyProposer() public {
        _executeStrategy();

        vm.prank(vault);
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.updateParams(abi.encode(uint256(600e6), uint256(500e18), uint256(600)));
    }

    function test_updateParams_partialUpdate() public {
        _executeStrategy();

        // Only update repaymentAmount (minVVV = 0, deadlineOffset = 0 keeps current)
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint256(600e6), uint256(0), uint256(0)));

        assertEq(strategy.repaymentAmount(), 600e6);
        assertEq(strategy.minVVV(), MIN_VVV); // unchanged
        assertEq(strategy.deadlineOffset(), 300); // unchanged

        // Only update minVVV
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint256(0), uint256(800e18), uint256(0)));

        assertEq(strategy.repaymentAmount(), 600e6); // unchanged from previous update
        assertEq(strategy.minVVV(), 800e18);
        assertEq(strategy.deadlineOffset(), 300); // unchanged
    }

    // ── Helpers ──

    function _executeStrategy() internal {
        vm.prank(vault);
        usdc.approve(address(strategy), USDC_AMOUNT);
        vm.prank(vault);
        strategy.execute();
    }
}
