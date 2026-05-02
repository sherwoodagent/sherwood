// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StrategyFactory} from "../../src/StrategyFactory.sol";
import {MoonwellSupplyStrategy} from "../../src/strategies/MoonwellSupplyStrategy.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";
import {MockMToken} from "../mocks/MockMToken.sol";

/// @dev Stand-in for `SyndicateFactory.vaultToSyndicate(address)`. We do not
///      pull in the real factory because that would force a UUPS proxy +
///      governor + registry stand-up just to test a single auth gate.
contract MockSyndicateRegistry {
    mapping(address => uint256) public vaultToSyndicate;

    function register(address vault, uint256 id) external {
        vaultToSyndicate[vault] = id;
    }
}

/// @dev Minimal vault stand-in — implements IVaultMembership (`owner` + `isAgent`).
contract MockVault {
    address public owner;
    mapping(address => bool) public agents;

    constructor(address owner_) {
        owner = owner_;
    }

    function setAgent(address a, bool active) external {
        agents[a] = active;
    }

    function isAgent(address a) external view returns (bool) {
        return agents[a];
    }
}

/// @title StrategyFactory_auth — MS-C2 regression
/// @notice Before MS-C2, `StrategyFactory.cloneAndInit` and
///         `cloneAndInitDeterministic` were fully permissionless. Anyone
///         could clone any strategy template and bind the clone to an
///         arbitrary `vault` parameter — including a victim vault, locking
///         them into an attacker-controlled strategy adapter pointer if a
///         later proposal pinned it.
///
///         The fix gates both fns on:
///           1. `msg.sender == vault` — caller must BE the vault being bound.
///           2. SyndicateFactory has a non-zero `vaultToSyndicate(vault)` —
///              the vault must be a registered SyndicateFactory vault.
///
///         The legitimate caller path is the governor batch executing inside
///         the vault's `executeGovernorBatch` (delegatecall to
///         BatchExecutorLib), which makes the outer `msg.sender` arriving at
///         this factory equal to the vault.
contract StrategyFactoryAuthTest is Test {
    StrategyFactory public factory;
    MockSyndicateRegistry public registry;
    MoonwellSupplyStrategy public template;
    ERC20Mock public usdc;
    MockMToken public mUsdc;

    MockVault public registeredVault;
    MockVault public unregisteredVault;
    address public vaultOwner = makeAddr("vaultOwner");
    address public agentAddr = makeAddr("agent");
    address public attacker = makeAddr("attacker");
    address public proposer = makeAddr("proposer");

    function setUp() public {
        registry = new MockSyndicateRegistry();

        registeredVault = new MockVault(vaultOwner);
        registeredVault.setAgent(agentAddr, true);
        unregisteredVault = new MockVault(vaultOwner);

        registry.register(address(registeredVault), 1);

        factory = new StrategyFactory(address(registry));
        template = new MoonwellSupplyStrategy();
        usdc = new ERC20Mock("USDC", "USDC", 6);
        mUsdc = new MockMToken(address(usdc), "Moonwell USDC", "mUsdc");
    }

    function _initData() internal view returns (bytes memory) {
        return abi.encode(address(usdc), address(mUsdc), 1_000e6, 990e6, false);
    }

    // ── Constructor guards ──

    function test_constructor_zeroSyndicateFactory_reverts() public {
        vm.expectRevert(StrategyFactory.InvalidSyndicateFactory.selector);
        new StrategyFactory(address(0));
    }

    // ── cloneAndInit ──

    /// @notice MS-C2: a random EOA that is neither vault, owner, nor a
    ///         registered agent cannot clone-and-bind a strategy.
    function test_cloneAndInit_revertsForRandomEoa() public {
        vm.prank(attacker);
        vm.expectRevert(StrategyFactory.Unauthorized.selector);
        factory.cloneAndInit(address(template), address(registeredVault), proposer, _initData());
    }

    /// @notice MS-C2: an unregistered vault always fails — even when the caller
    ///         IS that vault (no spoofing the membership view).
    function test_cloneAndInit_revertsForUnregisteredVault() public {
        vm.prank(address(unregisteredVault));
        vm.expectRevert(StrategyFactory.VaultNotRegistered.selector);
        factory.cloneAndInit(address(template), address(unregisteredVault), proposer, _initData());
    }

    /// @notice MS-C2: an outsider cannot pass a registered vault as `vault`
    ///         to bind a clone to a victim.
    function test_cloneAndInit_revertsWhenVaultMismatchesSender() public {
        vm.prank(attacker);
        vm.expectRevert(StrategyFactory.Unauthorized.selector);
        factory.cloneAndInit(address(template), address(registeredVault), proposer, _initData());
    }

    /// @notice MS-C2: the vault itself cannot pre-deploy (strategies must be
    ///         pre-deployed by owner/agent — the governor does not deploy
    ///         strategies during executeProposal).
    function test_cloneAndInit_revertsWhenVaultIsCaller() public {
        vm.prank(address(registeredVault));
        vm.expectRevert(StrategyFactory.Unauthorized.selector);
        factory.cloneAndInit(address(template), address(registeredVault), proposer, _initData());
    }

    /// @notice Happy path: the vault owner (creator pre-deploy).
    function test_cloneAndInit_succeedsForVaultOwner() public {
        vm.prank(vaultOwner);
        address clone = factory.cloneAndInit(address(template), address(registeredVault), proposer, _initData());
        assertTrue(clone != address(0));
    }

    /// @notice Happy path: a registered agent (agent pre-deploy).
    function test_cloneAndInit_succeedsForRegisteredAgent() public {
        vm.prank(agentAddr);
        address clone = factory.cloneAndInit(address(template), address(registeredVault), proposer, _initData());
        assertTrue(clone != address(0));
    }

    /// @notice MS-C2: a deregistered agent loses access.
    function test_cloneAndInit_revertsAfterAgentDeregistered() public {
        registeredVault.setAgent(agentAddr, false);
        vm.prank(agentAddr);
        vm.expectRevert(StrategyFactory.Unauthorized.selector);
        factory.cloneAndInit(address(template), address(registeredVault), proposer, _initData());
    }

    // ── cloneAndInitDeterministic ──

    function test_cloneAndInitDeterministic_revertsForRandomEoa() public {
        vm.prank(attacker);
        vm.expectRevert(StrategyFactory.Unauthorized.selector);
        factory.cloneAndInitDeterministic(
            address(template), address(registeredVault), proposer, _initData(), bytes32("salt")
        );
    }

    function test_cloneAndInitDeterministic_revertsForUnregisteredVault() public {
        vm.prank(address(unregisteredVault));
        vm.expectRevert(StrategyFactory.VaultNotRegistered.selector);
        factory.cloneAndInitDeterministic(
            address(template), address(unregisteredVault), proposer, _initData(), bytes32("salt")
        );
    }

    function test_cloneAndInitDeterministic_succeedsForRegisteredAgent() public {
        bytes32 salt = keccak256("strategy.salt.1");
        vm.prank(agentAddr);
        address clone =
            factory.cloneAndInitDeterministic(address(template), address(registeredVault), proposer, _initData(), salt);
        assertTrue(clone != address(0));
        assertEq(MoonwellSupplyStrategy(payable(clone)).vault(), address(registeredVault));
    }

    // ── Fuzz: no random caller can clone (must be vault/owner/agent) ──

    function testFuzz_cloneAndInit_revertsForAnyUnauthorizedCaller(address caller) public {
        vm.assume(caller != vaultOwner);
        vm.assume(caller != agentAddr);
        vm.assume(caller != address(0));
        vm.assume(uint160(caller) > 0xff);

        vm.prank(caller);
        vm.expectRevert(StrategyFactory.Unauthorized.selector);
        factory.cloneAndInit(address(template), address(registeredVault), proposer, _initData());
    }
}
