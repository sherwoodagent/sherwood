// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {VeniceInferenceStrategy, IVeniceStaking, IAeroRouter} from "../src/strategies/VeniceInferenceStrategy.sol";
import {BaseStrategy} from "../src/strategies/BaseStrategy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/// @notice Mock Venice staking — accepts VVV, mints sVVV to recipient, handles unstake with cooldown
contract MockVeniceStaking is ERC20Mock {
    ERC20Mock public vvvToken;
    uint256 public cooldownDuration;

    struct UnstakeRequest {
        uint256 amount;
        uint256 readyAt;
    }

    mapping(address => UnstakeRequest) public unstakeRequests;

    constructor(address vvv_, uint256 cooldown_) ERC20Mock("Staked VVV", "sVVV", 18) {
        vvvToken = ERC20Mock(vvv_);
        cooldownDuration = cooldown_;
    }

    function stake(address recipient, uint256 amount) external {
        vvvToken.transferFrom(msg.sender, address(this), amount);
        _mint(recipient, amount); // 1:1 sVVV
    }

    function initiateUnstake(uint256 amount) external {
        _burn(msg.sender, amount);
        unstakeRequests[msg.sender] = UnstakeRequest({amount: amount, readyAt: block.timestamp + cooldownDuration});
    }

    function finalizeUnstake() external {
        UnstakeRequest memory req = unstakeRequests[msg.sender];
        require(req.amount > 0, "No unstake request");
        require(block.timestamp >= req.readyAt, "Cooldown not elapsed");

        delete unstakeRequests[msg.sender];
        vvvToken.mint(msg.sender, req.amount); // return VVV
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
    uint256 constant COOLDOWN = 1 hours;

    function setUp() public {
        vvvToken = new ERC20Mock("VVV", "VVV", 18);
        sVVVToken = new MockVeniceStaking(address(vvvToken), COOLDOWN);
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
        assertFalse(strategy.needsSwap());
        assertEq(strategy.stakedAmount(), 0);
        assertFalse(strategy.unstakeInitiated());
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

    // ── Settle ──

    function test_settle() public {
        _executeStrategy();

        vm.prank(agentWallet);
        sVVVToken.approve(address(strategy), VVV_AMOUNT);

        vm.prank(vault);
        strategy.settle();

        assertEq(sVVVToken.balanceOf(agentWallet), 0);
        assertEq(sVVVToken.balanceOf(address(strategy)), 0); // burned by initiateUnstake
        assertTrue(strategy.unstakeInitiated());
        assertEq(uint256(strategy.state()), uint256(BaseStrategy.State.Settled));
    }

    function test_settle_agentNotApproved_reverts() public {
        _executeStrategy();
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

    // ── ClaimVVV ──

    function test_claimVVV() public {
        _executeAndSettle();
        vm.warp(block.timestamp + COOLDOWN);

        strategy.claimVVV();

        assertEq(vvvToken.balanceOf(vault), 10_000e18); // all returned
        assertEq(vvvToken.balanceOf(address(strategy)), 0);
        assertFalse(strategy.unstakeInitiated());
    }

    function test_claimVVV_beforeCooldown_reverts() public {
        _executeAndSettle();
        vm.expectRevert("Cooldown not elapsed");
        strategy.claimVVV();
    }

    function test_claimVVV_beforeSettled_reverts() public {
        _executeStrategy();
        vm.expectRevert(VeniceInferenceStrategy.NotSettled.selector);
        strategy.claimVVV();
    }

    function test_claimVVV_twice_reverts() public {
        _executeAndSettle();
        vm.warp(block.timestamp + COOLDOWN);
        strategy.claimVVV();

        vm.expectRevert(VeniceInferenceStrategy.NothingToClaim.selector);
        strategy.claimVVV();
    }

    // ── Full Lifecycle (direct) ──

    function test_fullLifecycle() public {
        // 1. Agent pre-approves clawback
        vm.prank(agentWallet);
        sVVVToken.approve(address(strategy), type(uint256).max);

        // 2. Execute
        vm.prank(vault);
        vvvToken.approve(address(strategy), VVV_AMOUNT);
        vm.prank(vault);
        strategy.execute();
        assertEq(sVVVToken.balanceOf(agentWallet), VVV_AMOUNT);

        // 3. Settle
        vm.prank(vault);
        strategy.settle();
        assertEq(sVVVToken.balanceOf(agentWallet), 0);
        assertTrue(strategy.unstakeInitiated());

        // 4. Cooldown
        vm.warp(block.timestamp + COOLDOWN);

        // 5. Claim
        strategy.claimVVV();
        assertEq(vvvToken.balanceOf(vault), 10_000e18);
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
    }

    // ── Helpers ──

    function _executeStrategy() internal {
        vm.prank(vault);
        vvvToken.approve(address(strategy), VVV_AMOUNT);
        vm.prank(vault);
        strategy.execute();
    }

    function _executeAndSettle() internal {
        _executeStrategy();
        vm.prank(agentWallet);
        sVVVToken.approve(address(strategy), VVV_AMOUNT);
        vm.prank(vault);
        strategy.settle();
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
    uint256 constant COOLDOWN = 1 hours;

    function setUp() public {
        usdc = new ERC20Mock("USD Coin", "USDC", 6);
        vvvToken = new ERC20Mock("VVV", "VVV", 18);
        sVVVToken = new MockVeniceStaking(address(vvvToken), COOLDOWN);
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

    function test_initialize_swap() public view {
        assertEq(strategy.asset(), address(usdc));
        assertEq(strategy.vvv(), address(vvvToken));
        assertTrue(strategy.needsSwap());
        assertEq(strategy.assetAmount(), USDC_AMOUNT);
        assertEq(strategy.minVVV(), MIN_VVV);
        assertEq(strategy.deadlineOffset(), 300);
        assertTrue(strategy.singleHop());
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

    function test_execute_swap() public {
        // Vault approves strategy
        vm.prank(vault);
        usdc.approve(address(strategy), USDC_AMOUNT);

        // Execute — pulls USDC, swaps to VVV, stakes to agent
        vm.prank(vault);
        strategy.execute();

        // Mock gives 2 VVV per USDC unit
        uint256 expectedVVV = (USDC_AMOUNT * SWAP_RATE) / 1e18;

        assertEq(sVVVToken.balanceOf(agentWallet), expectedVVV);
        assertEq(strategy.stakedAmount(), expectedVVV);
        assertTrue(strategy.executed());
    }

    function test_fullLifecycle_swap() public {
        // Pre-approve clawback
        vm.prank(agentWallet);
        sVVVToken.approve(address(strategy), type(uint256).max);

        // Execute
        vm.prank(vault);
        usdc.approve(address(strategy), USDC_AMOUNT);
        vm.prank(vault);
        strategy.execute();

        uint256 staked = strategy.stakedAmount();
        assertGt(staked, 0);

        // Settle
        vm.prank(vault);
        strategy.settle();
        assertTrue(strategy.unstakeInitiated());

        // Cooldown + claim
        vm.warp(block.timestamp + COOLDOWN);
        strategy.claimVVV();

        // VVV returned to vault (not USDC — vault holds VVV after unstake)
        assertEq(vvvToken.balanceOf(vault), staked);
    }

    // ── updateParams ──

    function test_updateParams() public {
        _executeStrategy();

        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint256(500e18), uint256(600)));

        assertEq(strategy.minVVV(), 500e18);
        assertEq(strategy.deadlineOffset(), 600);
    }

    function test_updateParams_partialUpdate() public {
        _executeStrategy();

        // Only update minVVV (deadlineOffset = 0 keeps current)
        vm.prank(proposer);
        strategy.updateParams(abi.encode(uint256(500e18), uint256(0)));

        assertEq(strategy.minVVV(), 500e18);
        assertEq(strategy.deadlineOffset(), 300); // unchanged
    }

    function test_updateParams_onlyProposer() public {
        _executeStrategy();

        vm.prank(vault);
        vm.expectRevert(BaseStrategy.NotProposer.selector);
        strategy.updateParams(abi.encode(uint256(500e18), uint256(600)));
    }

    // ── Multi-hop (M3) ──

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

    function _executeStrategy() internal {
        vm.prank(vault);
        usdc.approve(address(strategy), USDC_AMOUNT);
        vm.prank(vault);
        strategy.execute();
    }
}
