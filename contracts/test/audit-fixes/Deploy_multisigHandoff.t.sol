// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {DeploySherwood} from "../../script/Deploy.s.sol";
import {Create3Factory} from "../../src/Create3Factory.sol";
import {GuardianRegistry} from "../../src/GuardianRegistry.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {SyndicateFactory} from "../../src/SyndicateFactory.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {ERC20Mock} from "../mocks/ERC20Mock.sol";

/// @notice Trivial contract used as a stand-in for a Gnosis Safe in tests.
///         The deploy script's only check is `code.length > 0` — anything with
///         deployed bytecode satisfies it.
contract MockMultisig {
    receive() external payable {}
}

/// @notice Test-only subclass that exposes `_handoffOwnership` so we can
///         exercise the post-deploy ceremony in isolation without re-running
///         the full broadcast flow.
contract DeploySherwoodHarness is DeploySherwood {
    function exposed_handoffOwnership(
        address governorAddr,
        address factoryAddr,
        address registryAddr,
        address ownerMultisig
    ) external {
        _handoffOwnership(governorAddr, factoryAddr, registryAddr, ownerMultisig);
    }
}

/// @title Deploy_multisigHandoff — MS-H5 regression
/// @notice Confirms that:
///         1. The deploy script transfers ownership of Governor + Factory +
///            GuardianRegistry to the configured `OWNER_MULTISIG` after init,
///            so a deployer-key compromise post-deploy cannot take over the
///            protocol.
///         2. The script's env-var preconditions reject `address(0)` and
///            EOA owners (a trivial test would forget the `code.length > 0`
///            guard and ship a single-EOA-owner deployment).
///
/// @dev    Driving the full `forge script` from a unit test is brittle (chain
///         id / chains.json IO / broadcast plumbing). Instead we:
///           - Replicate the same deploy sequence the script uses, then
///           - Call the harness-exposed `_handoffOwnership` and
///           - Assert all three proxies report `owner() == multisig`.
///
///         The env-var validation is exercised by spawning a fresh
///         `DeploySherwood` and calling `run()` with `vm.setEnv`/`vm.expectRevert`.
///         For the address(0) and EOA paths, `run()` reverts before any deploy
///         happens, so we don't need WOOD_TOKEN / chains.json plumbing.
contract DeployMultisigHandoffTest is Test {
    bytes32 constant SALT_GOVERNOR_IMPL = keccak256("sherwood.deploy.governor-impl.2");
    bytes32 constant SALT_GOVERNOR_PROXY = keccak256("sherwood.deploy.governor-proxy.2");
    bytes32 constant SALT_FACTORY_IMPL = keccak256("sherwood.deploy.factory-impl.2");
    bytes32 constant SALT_FACTORY_PROXY = keccak256("sherwood.deploy.factory-proxy.2");
    bytes32 constant SALT_REGISTRY_IMPL = keccak256("sherwood.deploy.guardian-registry-impl.1");
    bytes32 constant SALT_REGISTRY_PROXY = keccak256("sherwood.deploy.guardian-registry-proxy.1");

    DeploySherwoodHarness internal harness;
    MockMultisig internal multisig;
    address internal deployer;

    function setUp() public {
        harness = new DeploySherwoodHarness();
        multisig = new MockMultisig();
        deployer = address(this);
        // `vm.setEnv` writes to the real OS environment and is NOT reverted
        // between tests. Reset every env var the deploy script reads so each
        // test starts from a known baseline regardless of run order.
        _clearDeployEnv();
    }

    function _clearDeployEnv() internal {
        vm.setEnv("OWNER_MULTISIG", "0x0000000000000000000000000000000000000000");
        vm.setEnv("SKIP_MULTISIG_HANDOFF", "false");
        vm.setEnv("WOOD_TOKEN", "0x0000000000000000000000000000000000000000");
    }

    /// @notice MS-H5: after `_handoffOwnership`, all three proxies must report
    ///         `owner() == multisig`. The deployer EOA must be unable to call
    ///         any `onlyOwner` function.
    function test_handoffTransfersAllThreeProxies() public {
        (address governor, address factory, address registry) = _deployTriangle();

        // Sanity: pre-handoff, all three are owned by the deployer (the test
        // contract itself, since it deployed via this contract's `address(this)`).
        assertEq(Ownable(governor).owner(), deployer, "pre: governor owned by deployer");
        assertEq(Ownable(factory).owner(), deployer, "pre: factory owned by deployer");
        assertEq(Ownable(registry).owner(), deployer, "pre: registry owned by deployer");

        // Stage the harness as the temporary owner so it can exercise the
        // real `_handoffOwnership` implementation (which calls
        // `transferOwnership` from its own `msg.sender`). This is exactly what
        // the deploy script does: the deployer EOA owns the proxies post-init,
        // then the same EOA calls `_handoffOwnership` inside `vm.broadcast`.
        Ownable(governor).transferOwnership(address(harness));
        Ownable(factory).transferOwnership(address(harness));
        Ownable(registry).transferOwnership(address(harness));

        // Hand off via the harness-exposed entrypoint — exercises the real
        // `_handoffOwnership` body in `Deploy.s.sol`.
        harness.exposed_handoffOwnership(governor, factory, registry, address(multisig));

        // Post-handoff: all three must be owned by the multisig.
        assertEq(Ownable(governor).owner(), address(multisig), "post: governor owned by multisig");
        assertEq(Ownable(factory).owner(), address(multisig), "post: factory owned by multisig");
        assertEq(Ownable(registry).owner(), address(multisig), "post: registry owned by multisig");

        // Deployer EOA must no longer be authorized for any onlyOwner call.
        vm.expectRevert();
        SyndicateGovernor(governor).setVotingPeriod(2 days);

        vm.expectRevert();
        SyndicateFactory(factory).setManagementFeeBps(100);

        vm.expectRevert();
        GuardianRegistry(registry).setReviewPeriod(2 days);
    }

    /// @notice MS-H5: `run()` must reject both `address(0)` and EOA values for
    ///         `OWNER_MULTISIG`. Combined into a single test because Foundry's
    ///         `vm.setEnv` writes to OS env (shared state) and the visibility
    ///         of those writes across test boundaries is implementation-defined
    ///         — keeping both assertions in one test ensures deterministic
    ///         ordering of the env mutations relative to the `run()` calls.
    function test_run_rejectsBadOwnerMultisig() public {
        DeploySherwood s = new DeploySherwood();
        ERC20Mock wood = new ERC20Mock("WOOD", "WOOD", 18);
        vm.setEnv("WOOD_TOKEN", vm.toString(address(wood)));
        vm.setEnv("SKIP_MULTISIG_HANDOFF", "false");

        // Case 1: OWNER_MULTISIG unset / address(0).
        vm.setEnv("OWNER_MULTISIG", "0x0000000000000000000000000000000000000000");
        vm.expectRevert(bytes("OWNER_MULTISIG required (or set SKIP_MULTISIG_HANDOFF=true)"));
        s.run();

        // Case 2: OWNER_MULTISIG is an EOA (no deployed bytecode).
        // Hardcoded string (not `vm.toString(address(0xCAFE))`) so we don't
        // depend on Foundry's address-checksum encoding for the env round-trip.
        vm.setEnv("OWNER_MULTISIG", "0x000000000000000000000000000000000000cafe");
        vm.expectRevert(bytes("OWNER_MULTISIG must be a contract (Safe), not an EOA"));
        s.run();
    }

    /// @notice The `SKIP_MULTISIG_HANDOFF=true` escape hatch is intentionally
    ///         supported for ephemeral testnet/fork deploys — without it the
    ///         deploy can't proceed. Confirm that without invoking the handoff
    ///         the deployer remains the owner (i.e. no implicit handoff).
    function test_handoff_skipped_leavesDeployerAsOwner() public {
        (address governor, address factory, address registry) = _deployTriangle();
        // Without calling `_handoffOwnership`, the proxies stay deployer-owned.
        assertEq(Ownable(governor).owner(), deployer);
        assertEq(Ownable(factory).owner(), deployer);
        assertEq(Ownable(registry).owner(), deployer);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// @dev Replicates the (governor, registry, factory) CREATE3 triangle from
    ///      `Deploy.s.sol::deployCore`. Skips executor / vault impl / seeding /
    ///      `setFactory` — none of that is relevant to the handoff assertion.
    ///      Mirrors `DeployScript.t.sol` so the two stay in sync.
    function _deployTriangle() internal returns (address governor, address factory, address registry) {
        ERC20Mock wood = new ERC20Mock("WOOD", "WOOD", 18);
        Create3Factory c3 = new Create3Factory(deployer);

        address predictedRegistryProxy = c3.addressOf(SALT_REGISTRY_PROXY);
        address predictedFactoryProxy = c3.addressOf(SALT_FACTORY_PROXY);

        // Governor.
        address govImpl = c3.deploy(SALT_GOVERNOR_IMPL, abi.encodePacked(type(SyndicateGovernor).creationCode));
        bytes memory govInit = abi.encodeCall(
            SyndicateGovernor.initialize,
            (
                ISyndicateGovernor.InitParams({
                    owner: deployer,
                    votingPeriod: 1 days,
                    executionWindow: 1 days,
                    vetoThresholdBps: 4000,
                    maxPerformanceFeeBps: 3000,
                    cooldownPeriod: 1 days,
                    collaborationWindow: 48 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 hours,
                    maxStrategyDuration: 14 days,
                    protocolFeeBps: 200,
                    protocolFeeRecipient: deployer,
                    guardianFeeBps: 0
                }),
                predictedRegistryProxy
            )
        );
        governor = c3.deploy(
            SALT_GOVERNOR_PROXY, abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(govImpl, govInit))
        );

        // Registry (predicted factory address).
        address registryImpl = c3.deploy(SALT_REGISTRY_IMPL, abi.encodePacked(type(GuardianRegistry).creationCode));
        bytes memory regInit = abi.encodeCall(
            GuardianRegistry.initialize,
            (deployer, governor, predictedFactoryProxy, address(wood), 10_000e18, 10_000e18, 7 days, 24 hours, 3000)
        );
        registry = c3.deploy(
            SALT_REGISTRY_PROXY, abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(registryImpl, regInit))
        );
        require(registry == predictedRegistryProxy, "registry addr mismatch");

        // Factory.
        address factoryImpl = c3.deploy(SALT_FACTORY_IMPL, abi.encodePacked(type(SyndicateFactory).creationCode));
        bytes memory facInit = abi.encodeCall(
            SyndicateFactory.initialize,
            (SyndicateFactory.InitParams({
                    owner: deployer,
                    executorImpl: address(0xE1), // unused by handoff test
                    vaultImpl: address(0xE2),
                    ensRegistrar: address(0),
                    agentRegistry: address(0),
                    governor: governor,
                    managementFeeBps: 50,
                    guardianRegistry: registry
                }))
        );
        factory = c3.deploy(
            SALT_FACTORY_PROXY, abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(factoryImpl, facInit))
        );
        require(factory == predictedFactoryProxy, "factory addr mismatch");
    }
}
