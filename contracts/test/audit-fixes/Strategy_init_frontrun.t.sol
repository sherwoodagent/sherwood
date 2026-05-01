// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

import {BaseStrategy} from "../../src/strategies/BaseStrategy.sol";
import {MoonwellSupplyStrategy} from "../../src/strategies/MoonwellSupplyStrategy.sol";
import {AerodromeLPStrategy} from "../../src/strategies/AerodromeLPStrategy.sol";
import {PortfolioStrategy} from "../../src/strategies/PortfolioStrategy.sol";
import {WstETHMoonwellStrategy} from "../../src/strategies/WstETHMoonwellStrategy.sol";
import {MamoYieldStrategy} from "../../src/strategies/MamoYieldStrategy.sol";
import {VeniceInferenceStrategy} from "../../src/strategies/VeniceInferenceStrategy.sol";
import {HyperliquidGridStrategy} from "../../src/strategies/HyperliquidGridStrategy.sol";
import {HyperliquidPerpStrategy} from "../../src/strategies/HyperliquidPerpStrategy.sol";

/// @title Strategy_init_frontrun — MS-C3 regression
/// @notice Verifies that every concrete strategy template is *uninitializable*
///         once deployed via `new`, while ERC-1167 minimal-proxy clones spawned
///         from the template remain initializable. The constructor on
///         `BaseStrategy` flips `_initialized = true` so a separate-tx
///         `initialize` call on the template (e.g. an attacker front-running
///         a clone deployment that is split across two transactions) reverts
///         with `AlreadyInitialized`. Clones don't run constructors, so the
///         atomic `cloneAndInit` flow is unaffected.
contract StrategyInitFrontrunTest is Test {
    address public vault = makeAddr("vault");
    address public proposer = makeAddr("proposer");
    address public attacker = makeAddr("attacker");

    // Stub addresses — only need to be non-zero for init validation. The
    // tests assert revert on AlreadyInitialized *before* protocol-specific
    // checks ever run, so we don't need real protocol mocks here.
    address public stubToken = makeAddr("stubToken");
    address public stubProtocol = makeAddr("stubProtocol");

    // ── MoonwellSupplyStrategy ──

    function test_moonwell_template_is_locked() public {
        MoonwellSupplyStrategy template = new MoonwellSupplyStrategy();
        bytes memory initData = abi.encode(stubToken, stubProtocol, uint256(1), uint256(0), false);

        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        template.initialize(vault, proposer, initData);
    }

    function test_moonwell_clone_initializes() public {
        MoonwellSupplyStrategy template = new MoonwellSupplyStrategy();
        address payable clone = payable(Clones.clone(address(template)));
        bytes memory initData = abi.encode(stubToken, stubProtocol, uint256(1), uint256(0), false);

        MoonwellSupplyStrategy(clone).initialize(vault, proposer, initData);

        assertEq(MoonwellSupplyStrategy(clone).vault(), vault);
        assertEq(MoonwellSupplyStrategy(clone).proposer(), proposer);
    }

    // ── AerodromeLPStrategy ──

    function test_aerodrome_template_is_locked() public {
        AerodromeLPStrategy template = new AerodromeLPStrategy();
        AerodromeLPStrategy.InitParams memory p = AerodromeLPStrategy.InitParams({
            tokenA: stubToken,
            tokenB: makeAddr("tokenB"),
            stable: false,
            factory: makeAddr("factory"),
            router: makeAddr("router"),
            gauge: address(0),
            lpToken: makeAddr("lp"),
            amountADesired: 1e18,
            amountBDesired: 1e18,
            amountAMin: 1,
            amountBMin: 0,
            minAmountAOut: 1,
            minAmountBOut: 0
        });

        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        template.initialize(vault, proposer, abi.encode(p));
    }

    function test_aerodrome_clone_initializes() public {
        AerodromeLPStrategy template = new AerodromeLPStrategy();
        address payable clone = payable(Clones.clone(address(template)));
        AerodromeLPStrategy.InitParams memory p = AerodromeLPStrategy.InitParams({
            tokenA: stubToken,
            tokenB: makeAddr("tokenB"),
            stable: false,
            factory: makeAddr("factory"),
            router: makeAddr("router"),
            gauge: address(0),
            lpToken: makeAddr("lp"),
            amountADesired: 1e18,
            amountBDesired: 1e18,
            amountAMin: 1,
            amountBMin: 0,
            minAmountAOut: 1,
            minAmountBOut: 0
        });

        AerodromeLPStrategy(clone).initialize(vault, proposer, abi.encode(p));
        assertEq(AerodromeLPStrategy(clone).vault(), vault);
    }

    // ── PortfolioStrategy ──

    function test_portfolio_template_is_locked() public {
        PortfolioStrategy template = new PortfolioStrategy();
        address[] memory tokens = new address[](1);
        tokens[0] = makeAddr("tokenA");
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10_000;
        bytes[] memory extra = new bytes[](1);
        extra[0] = "";
        bytes memory initData =
            abi.encode(stubToken, makeAddr("adapter"), address(0), tokens, weights, uint256(1e6), uint256(100), extra);

        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        template.initialize(vault, proposer, initData);
    }

    function test_portfolio_clone_initializes() public {
        PortfolioStrategy template = new PortfolioStrategy();
        address payable clone = payable(Clones.clone(address(template)));
        address[] memory tokens = new address[](1);
        tokens[0] = makeAddr("tokenA");
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10_000;
        bytes[] memory extra = new bytes[](1);
        extra[0] = "";
        bytes memory initData =
            abi.encode(stubToken, makeAddr("adapter"), address(0), tokens, weights, uint256(1e6), uint256(100), extra);

        PortfolioStrategy(clone).initialize(vault, proposer, initData);
        assertEq(PortfolioStrategy(clone).vault(), vault);
    }

    // ── WstETHMoonwellStrategy ──

    function test_wsteth_template_is_locked() public {
        WstETHMoonwellStrategy template = new WstETHMoonwellStrategy();
        WstETHMoonwellStrategy.InitParams memory p = WstETHMoonwellStrategy.InitParams({
            weth: stubToken,
            wsteth: makeAddr("wsteth"),
            mwsteth: makeAddr("mwsteth"),
            aeroRouter: makeAddr("router"),
            aeroFactory: makeAddr("factory"),
            supplyAmount: 1e18,
            minWstethOutPerWeth: 1e17,
            minWethOutPerWsteth: 1e17,
            deadlineOffset: 0
        });

        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        template.initialize(vault, proposer, abi.encode(p));
    }

    function test_wsteth_clone_initializes() public {
        WstETHMoonwellStrategy template = new WstETHMoonwellStrategy();
        address payable clone = payable(Clones.clone(address(template)));
        WstETHMoonwellStrategy.InitParams memory p = WstETHMoonwellStrategy.InitParams({
            weth: stubToken,
            wsteth: makeAddr("wsteth"),
            mwsteth: makeAddr("mwsteth"),
            aeroRouter: makeAddr("router"),
            aeroFactory: makeAddr("factory"),
            supplyAmount: 1e18,
            minWstethOutPerWeth: 1e17,
            minWethOutPerWsteth: 1e17,
            deadlineOffset: 0
        });

        WstETHMoonwellStrategy(clone).initialize(vault, proposer, abi.encode(p));
        assertEq(WstETHMoonwellStrategy(clone).vault(), vault);
    }

    // ── Other concrete strategies — template lock only ──
    // Coverage check: confirm every concrete strategy that derives from
    // BaseStrategy is uninitializable on the template. We don't need to
    // cover the clone-init path for these — the BaseStrategy constructor
    // is the single mechanism, and the four cases above already prove
    // that clones still initialize correctly.

    function test_mamo_template_is_locked() public {
        MamoYieldStrategy template = new MamoYieldStrategy();
        bytes memory initData = abi.encode(stubToken, makeAddr("mamoFactory"), uint256(0), bytes32(0));

        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        template.initialize(vault, proposer, initData);
    }

    function test_venice_template_is_locked() public {
        VeniceInferenceStrategy template = new VeniceInferenceStrategy();

        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        template.initialize(vault, proposer, "");
    }

    function test_hlGrid_template_is_locked() public {
        HyperliquidGridStrategy template = new HyperliquidGridStrategy();

        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        template.initialize(vault, proposer, "");
    }

    function test_hlPerp_template_is_locked() public {
        HyperliquidPerpStrategy template = new HyperliquidPerpStrategy();

        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        template.initialize(vault, proposer, "");
    }
}
