// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {SyndicateFactory} from "../../src/SyndicateFactory.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {MinimalGuardianRegistry} from "../../src/MinimalGuardianRegistry.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";

/// @title SetGuardianRegistry — owner-only registry repointing
/// @notice Lets the protocol upgrade from the beta `MinimalGuardianRegistry`
///         to the real `GuardianRegistry` once WOOD is live without redeploying
///         the governor + factory proxies.
contract SetGuardianRegistryTest is Test {
    SyndicateGovernor governor;
    SyndicateFactory factory;
    MinimalGuardianRegistry initialRegistry;
    MinimalGuardianRegistry replacementRegistry;

    address owner = makeAddr("owner");
    address attacker = makeAddr("attacker");

    function setUp() public {
        initialRegistry = new MinimalGuardianRegistry();
        replacementRegistry = new MinimalGuardianRegistry();

        // Governor proxy
        SyndicateGovernor govImpl = new SyndicateGovernor();
        bytes memory govInit = abi.encodeCall(
            SyndicateGovernor.initialize,
            (
                ISyndicateGovernor.InitParams({
                    owner: owner,
                    votingPeriod: 1 hours,
                    executionWindow: 1 days,
                    vetoThresholdBps: 4000,
                    maxPerformanceFeeBps: 3000,
                    cooldownPeriod: 1 hours,
                    collaborationWindow: 24 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 hours,
                    maxStrategyDuration: 14 days,
                    protocolFeeBps: 200,
                    protocolFeeRecipient: owner,
                    guardianFeeBps: 0
                }),
                address(initialRegistry)
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));

        // Factory proxy (wired with governor + initial registry)
        BatchExecutorLib executorLib = new BatchExecutorLib();
        SyndicateVault vaultImpl = new SyndicateVault();
        SyndicateFactory factoryImpl = new SyndicateFactory();
        bytes memory factoryInit = abi.encodeCall(
            SyndicateFactory.initialize,
            (SyndicateFactory.InitParams({
                    owner: owner,
                    executorImpl: address(executorLib),
                    vaultImpl: address(vaultImpl),
                    ensRegistrar: address(0),
                    agentRegistry: address(0),
                    governor: address(governor),
                    managementFeeBps: 0,
                    guardianRegistry: address(initialRegistry)
                }))
        );
        factory = SyndicateFactory(address(new ERC1967Proxy(address(factoryImpl), factoryInit)));

        vm.prank(owner);
        governor.setFactory(address(factory));
    }

    function test_governor_setGuardianRegistry_succeedsForOwner() public {
        assertEq(governor.guardianRegistry(), address(initialRegistry));
        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit ISyndicateGovernor.GuardianRegistrySet(address(initialRegistry), address(replacementRegistry));
        governor.setGuardianRegistry(address(replacementRegistry));
        assertEq(governor.guardianRegistry(), address(replacementRegistry));
    }

    function test_governor_setGuardianRegistry_revertsForAttacker() public {
        vm.prank(attacker);
        vm.expectRevert();
        governor.setGuardianRegistry(address(replacementRegistry));
    }

    function test_governor_setGuardianRegistry_revertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.ZeroAddress.selector);
        governor.setGuardianRegistry(address(0));
    }

    function test_factory_setGuardianRegistry_succeedsForOwner() public {
        assertEq(factory.guardianRegistry(), address(initialRegistry));
        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit SyndicateFactory.GuardianRegistrySet(address(initialRegistry), address(replacementRegistry));
        factory.setGuardianRegistry(address(replacementRegistry));
        assertEq(factory.guardianRegistry(), address(replacementRegistry));
    }

    function test_factory_setGuardianRegistry_revertsForAttacker() public {
        vm.prank(attacker);
        vm.expectRevert();
        factory.setGuardianRegistry(address(replacementRegistry));
    }

    function test_factory_setGuardianRegistry_revertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(SyndicateFactory.InvalidGuardianRegistry.selector);
        factory.setGuardianRegistry(address(0));
    }
}
