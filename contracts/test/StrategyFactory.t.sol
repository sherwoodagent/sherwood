// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {StrategyFactory} from "../src/StrategyFactory.sol";
import {MoonwellSupplyStrategy} from "../src/strategies/MoonwellSupplyStrategy.sol";
import {BaseStrategy} from "../src/strategies/BaseStrategy.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";
import {MockMToken} from "./mocks/MockMToken.sol";

contract StrategyFactoryTest is Test {
    StrategyFactory factory;
    MoonwellSupplyStrategy template;
    ERC20Mock usdc;
    MockMToken mUsdc;

    address vault = makeAddr("vault");
    address proposer = makeAddr("proposer");
    address attacker = makeAddr("attacker");

    function setUp() public {
        factory = new StrategyFactory();
        template = new MoonwellSupplyStrategy();
        usdc = new ERC20Mock("USDC", "USDC", 6);
        mUsdc = new MockMToken(address(usdc), "Moonwell USDC", "mUsdc");
    }

    function test_cloneAndInit_atomic() public {
        bytes memory initData = abi.encode(address(usdc), address(mUsdc), 1_000e6, 990e6, false);
        address clone = factory.cloneAndInit(address(template), vault, proposer, initData);

        MoonwellSupplyStrategy strategy = MoonwellSupplyStrategy(payable(clone));
        assertEq(strategy.vault(), vault);
        assertEq(strategy.proposer(), proposer);
        assertEq(strategy.supplyAmount(), 1_000e6);
    }

    function test_cloneAndInit_initializeAgain_reverts() public {
        bytes memory initData = abi.encode(address(usdc), address(mUsdc), 1_000e6, 990e6, false);
        address clone = factory.cloneAndInit(address(template), vault, proposer, initData);

        // Anyone trying to re-initialize the clone (front-run attack post-init)
        // is rejected by the existing _initialized flag.
        vm.prank(attacker);
        vm.expectRevert(BaseStrategy.AlreadyInitialized.selector);
        MoonwellSupplyStrategy(payable(clone)).initialize(attacker, attacker, initData);
    }

    function test_cloneAndInitDeterministic_predictableAddress() public {
        bytes32 salt = keccak256("strategy.salt.1");
        bytes memory initData = abi.encode(address(usdc), address(mUsdc), 1_000e6, 990e6, false);
        address predicted = Clones.predictDeterministicAddress(address(template), salt, address(factory));
        address clone = factory.cloneAndInitDeterministic(address(template), vault, proposer, initData, salt);
        assertEq(clone, predicted);
    }
}
