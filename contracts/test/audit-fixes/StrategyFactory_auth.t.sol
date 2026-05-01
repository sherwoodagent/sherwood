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

    address public registeredVault = makeAddr("registeredVault");
    address public unregisteredVault = makeAddr("unregisteredVault");
    address public attacker = makeAddr("attacker");
    address public proposer = makeAddr("proposer");

    function setUp() public {
        registry = new MockSyndicateRegistry();
        registry.register(registeredVault, 1);

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

    /// @notice MS-C2: a random EOA cannot clone-and-bind a strategy to an
    ///         arbitrary vault. The auth check is `msg.sender == vault`, so
    ///         any non-vault caller fails the very first gate.
    function test_cloneAndInit_revertsForRandomEoa() public {
        vm.prank(attacker);
        vm.expectRevert(StrategyFactory.Unauthorized.selector);
        factory.cloneAndInit(address(template), registeredVault, proposer, _initData());
    }

    /// @notice MS-C2: even if the attacker spoofs a vault address by deploying
    ///         a contract at that address, an unregistered vault still fails
    ///         the registry check.
    function test_cloneAndInit_revertsForUnregisteredVault() public {
        // Caller IS the vault (passes check #1) but the vault is not
        // registered with the SyndicateFactory (fails check #2).
        vm.prank(unregisteredVault);
        vm.expectRevert(StrategyFactory.VaultNotRegistered.selector);
        factory.cloneAndInit(address(template), unregisteredVault, proposer, _initData());
    }

    /// @notice MS-C2: `vault` parameter must match `msg.sender`. An attacker
    ///         calling from their own EOA cannot pass `registeredVault` as
    ///         the `vault` argument to bind a clone to a victim.
    function test_cloneAndInit_revertsWhenVaultMismatchesSender() public {
        vm.prank(attacker);
        vm.expectRevert(StrategyFactory.Unauthorized.selector);
        factory.cloneAndInit(address(template), registeredVault, proposer, _initData());
    }

    /// @notice Happy path: the registered vault calling on its own behalf
    ///         succeeds. This mirrors the governor → vault delegatecall →
    ///         StrategyFactory path where the outer msg.sender is the vault.
    function test_cloneAndInit_succeedsForRegisteredVault() public {
        vm.prank(registeredVault);
        address clone = factory.cloneAndInit(address(template), registeredVault, proposer, _initData());
        assertTrue(clone != address(0));
        assertEq(MoonwellSupplyStrategy(payable(clone)).vault(), registeredVault);
        assertEq(MoonwellSupplyStrategy(payable(clone)).proposer(), proposer);
    }

    // ── cloneAndInitDeterministic ──

    /// @notice MS-C2: deterministic variant has the same auth gate.
    function test_cloneAndInitDeterministic_revertsForRandomEoa() public {
        vm.prank(attacker);
        vm.expectRevert(StrategyFactory.Unauthorized.selector);
        factory.cloneAndInitDeterministic(address(template), registeredVault, proposer, _initData(), bytes32("salt"));
    }

    function test_cloneAndInitDeterministic_revertsForUnregisteredVault() public {
        vm.prank(unregisteredVault);
        vm.expectRevert(StrategyFactory.VaultNotRegistered.selector);
        factory.cloneAndInitDeterministic(address(template), unregisteredVault, proposer, _initData(), bytes32("salt"));
    }

    function test_cloneAndInitDeterministic_revertsWhenVaultMismatchesSender() public {
        vm.prank(attacker);
        vm.expectRevert(StrategyFactory.Unauthorized.selector);
        factory.cloneAndInitDeterministic(address(template), registeredVault, proposer, _initData(), bytes32("salt"));
    }

    function test_cloneAndInitDeterministic_succeedsForRegisteredVault() public {
        bytes32 salt = keccak256("strategy.salt.1");
        vm.prank(registeredVault);
        address clone =
            factory.cloneAndInitDeterministic(address(template), registeredVault, proposer, _initData(), salt);
        assertTrue(clone != address(0));
        assertEq(MoonwellSupplyStrategy(payable(clone)).vault(), registeredVault);
    }

    // ── Fuzz: no caller other than the vault itself can clone ──

    function testFuzz_cloneAndInit_revertsForAnyNonVaultCaller(address caller) public {
        vm.assume(caller != registeredVault);
        // Skip precompiles / zero / well-known addresses that vm.prank refuses.
        vm.assume(caller != address(0));
        vm.assume(uint160(caller) > 0xff);

        vm.prank(caller);
        vm.expectRevert(StrategyFactory.Unauthorized.selector);
        factory.cloneAndInit(address(template), registeredVault, proposer, _initData());
    }
}
