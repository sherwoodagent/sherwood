// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Create3Factory} from "../src/Create3Factory.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {SyndicateFactory} from "../src/SyndicateFactory.sol";
import {SyndicateGovernor} from "../src/SyndicateGovernor.sol";
import {GuardianRegistry} from "../src/GuardianRegistry.sol";
import {ISyndicateGovernor} from "../src/interfaces/ISyndicateGovernor.sol";
import {ScriptBase} from "./ScriptBase.sol";

/**
 * @notice Generic Sherwood protocol deployment via CREATE3.
 *
 *         Deploys a Create3Factory first (regular CREATE), then uses it for
 *         all subsequent deploys. Each deploy is a single CALL transaction,
 *         avoiding the 2-tx problem where Foundry splits create2 into
 *         CREATE2+CALL broadcast pairs that desync on some RPCs.
 *
 *         Deterministic addresses based on (factory, salt). Same factory
 *         address + same salts = same protocol addresses on any chain.
 *
 *   Environment variables:
 *     ENS_REGISTRAR     — L2 Registrar address (default: 0x0 = no ENS)
 *     AGENT_REGISTRY    — ERC-8004 Identity Registry (default: 0x0 = no identity)
 *     MANAGEMENT_FEE    — Management fee in bps (default: 50 = 0.5%)
 *     PROTOCOL_FEE      — Protocol fee in bps (default: 200 = 2%)
 *     MAX_STRATEGY_DAYS — Max strategy duration in days (default: 14)
 *
 *   Usage:
 *     forge script script/Deploy.s.sol:DeploySherwood \
 *       --rpc-url <chain> --account <acct> --sender <addr> --broadcast --slow
 */
contract DeploySherwood is ScriptBase {
    // ── CREATE3 salts ──
    bytes32 constant SALT_EXECUTOR = keccak256("sherwood.deploy.executor.2");
    bytes32 constant SALT_VAULT_IMPL = keccak256("sherwood.deploy.vault-impl.2");
    bytes32 constant SALT_GOVERNOR_IMPL = keccak256("sherwood.deploy.governor-impl.2");
    bytes32 constant SALT_GOVERNOR_PROXY = keccak256("sherwood.deploy.governor-proxy.2");
    bytes32 constant SALT_FACTORY_IMPL = keccak256("sherwood.deploy.factory-impl.2");
    bytes32 constant SALT_FACTORY_PROXY = keccak256("sherwood.deploy.factory-proxy.2");
    bytes32 constant SALT_REGISTRY_IMPL = keccak256("sherwood.deploy.guardian-registry-impl.1");
    bytes32 constant SALT_REGISTRY_PROXY = keccak256("sherwood.deploy.guardian-registry-proxy.1");

    // ── Registry default parameters (spec §3.1; overridable via env) ──
    uint256 constant DEFAULT_MIN_GUARDIAN_STAKE = 10_000e18;
    uint256 constant DEFAULT_MIN_OWNER_STAKE = 10_000e18;
    uint256 constant DEFAULT_COOLDOWN = 7 days;
    uint256 constant DEFAULT_REVIEW_PERIOD = 24 hours;
    uint256 constant DEFAULT_BLOCK_QUORUM_BPS = 3000; // 30%
    uint256 constant DEFAULT_SLASH_APPEAL_SEED = 1_000_000e18;
    uint256 constant DEFAULT_EPOCH_ZERO_SEED = 10_000e18;

    struct Config {
        address ensRegistrar;
        address agentRegistry;
        uint256 managementFeeBps;
        uint256 protocolFeeBps;
        uint256 maxStrategyDays;
        address woodToken;
        uint256 slashAppealSeed;
        uint256 epochZeroSeed;
    }

    struct Deployed {
        address deployer;
        address executorLib;
        address vaultImpl;
        address governorProxy;
        address factoryProxy;
        address registryProxy;
    }

    function run() external {
        Config memory cfg = Config({
            ensRegistrar: vm.envOr("ENS_REGISTRAR", address(0)),
            agentRegistry: vm.envOr("AGENT_REGISTRY", address(0)),
            managementFeeBps: vm.envOr("MANAGEMENT_FEE", uint256(50)),
            protocolFeeBps: vm.envOr("PROTOCOL_FEE", uint256(200)),
            maxStrategyDays: vm.envOr("MAX_STRATEGY_DAYS", uint256(14)),
            // WOOD_TOKEN is required — registry.initialize reverts on address(0).
            // Falls back to the chains/{chainId}.json entry when the env var is
            // unset, so deploys can reuse a previously-deployed WOOD without
            // manual exporting.
            woodToken: vm.envOr("WOOD_TOKEN", _tryReadAddress("WOOD_TOKEN")),
            slashAppealSeed: vm.envOr("SLASH_APPEAL_SEED", DEFAULT_SLASH_APPEAL_SEED),
            epochZeroSeed: vm.envOr("EPOCH_ZERO_SEED", DEFAULT_EPOCH_ZERO_SEED)
        });
        require(cfg.woodToken != address(0), "WOOD_TOKEN not set (env or chains.json)");

        vm.startBroadcast();

        Deployed memory d;
        d.deployer = msg.sender;
        console.log("Deployer:", d.deployer);
        console.log("Chain ID:", block.chainid);

        // 0. Deploy Create3Factory (regular CREATE — one tx)
        Create3Factory c3 = new Create3Factory();
        console.log("\nCreate3Factory:", address(c3));

        // 1. BatchExecutorLib
        d.executorLib = c3.deploy(SALT_EXECUTOR, abi.encodePacked(type(BatchExecutorLib).creationCode));
        console.log("BatchExecutorLib:", d.executorLib);

        // 2. SyndicateVault implementation
        d.vaultImpl = c3.deploy(SALT_VAULT_IMPL, abi.encodePacked(type(SyndicateVault).creationCode));
        console.log("VaultImpl:", d.vaultImpl);

        // 3. SyndicateGovernor implementation + proxy. The registry is required
        //    at init-time, but the registry itself needs the governor address,
        //    so we break the circular dep with CREATE3 `addressOf(salt)` —
        //    predict the registry proxy address, pass it to governor init, then
        //    deploy the registry at that address pointing at the real governor.
        address predictedRegistryProxy = c3.addressOf(SALT_REGISTRY_PROXY);
        console.log("Predicted RegistryProxy:", predictedRegistryProxy);
        address govImpl = c3.deploy(SALT_GOVERNOR_IMPL, abi.encodePacked(type(SyndicateGovernor).creationCode));
        d.governorProxy = _deployGovernorProxy(c3, govImpl, d.deployer, predictedRegistryProxy, cfg);
        console.log("GovernorProxy:", d.governorProxy);

        // 4. GuardianRegistry impl + proxy. Factory address also predicted via
        //    CREATE3 — same computation the Create3Factory uses at deploy time,
        //    so the prediction is exact regardless of deployer nonce.
        address predictedFactoryProxy = c3.addressOf(SALT_FACTORY_PROXY);
        console.log("Predicted FactoryProxy:", predictedFactoryProxy);
        address registryImpl = c3.deploy(SALT_REGISTRY_IMPL, abi.encodePacked(type(GuardianRegistry).creationCode));
        d.registryProxy =
            _deployRegistryProxy(c3, registryImpl, d.deployer, d.governorProxy, predictedFactoryProxy, cfg);
        console.log("GuardianRegistryProxy:", d.registryProxy);
        require(d.registryProxy == predictedRegistryProxy, "registry addr mismatch");

        // 5. SyndicateFactory impl + proxy — now with real registry address.
        address factoryImpl = c3.deploy(SALT_FACTORY_IMPL, abi.encodePacked(type(SyndicateFactory).creationCode));
        d.factoryProxy = _deployFactoryProxy(c3, factoryImpl, d, cfg);
        console.log("FactoryProxy:", d.factoryProxy);
        require(d.factoryProxy == predictedFactoryProxy, "factory addr mismatch");

        // 6. Register factory on governor. V1.5: setFactory applies
        //    immediately (owner-multisig governs via its own delay).
        SyndicateGovernor(d.governorProxy).setFactory(d.factoryProxy);
        console.log("Governor.setFactory applied");

        // 7. P1-1: guardian fee recipient pinned to `_guardianRegistry` at
        //    init — no separate wiring step needed.

        // 8. Seed slash appeal reserve + epoch 0 rewards (best-effort; skipped
        //    on zero amounts so testnets don't need a WOOD balance).
        _seedRegistry(d.deployer, d.registryProxy, cfg);

        vm.stopBroadcast();

        // ── Validate ──
        _validateGovernor(d.deployer, d.governorProxy, d.factoryProxy, cfg.maxStrategyDays);
        _validateFactory(
            d.deployer,
            d.governorProxy,
            d.factoryProxy,
            d.executorLib,
            d.vaultImpl,
            cfg.ensRegistrar,
            cfg.agentRegistry,
            cfg.managementFeeBps
        );
        _validateRegistry(d.registryProxy, d.governorProxy, d.factoryProxy, cfg.woodToken);

        // ── Persist ──
        _writeAddresses(_chainName(), d.deployer, d.factoryProxy, d.governorProxy, d.executorLib, d.vaultImpl);
        _patchAddress("GUARDIAN_REGISTRY", d.registryProxy);

        console.log("\nDeployment complete on %s (chain %s)", _chainName(), block.chainid);
        console.log("Create3Factory: %s (save for future deploys)", address(c3));
        console.log("Next: forge script script/DeployTemplates.s.sol --rpc-url <chain> --broadcast");
    }

    function _deployGovernorProxy(
        Create3Factory c3,
        address govImpl,
        address deployer,
        address registryProxy,
        Config memory cfg
    ) internal returns (address) {
        bytes memory initData = abi.encodeCall(
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
                    maxStrategyDuration: cfg.maxStrategyDays * 1 days,
                    protocolFeeBps: cfg.protocolFeeBps,
                    protocolFeeRecipient: deployer,
                    guardianFeeBps: 0
                }),
                registryProxy
            )
        );
        return c3.deploy(
            SALT_GOVERNOR_PROXY, abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(govImpl, initData))
        );
    }

    function _deployFactoryProxy(Create3Factory c3, address factoryImpl, Deployed memory d, Config memory cfg)
        internal
        returns (address)
    {
        bytes memory initData = abi.encodeCall(
            SyndicateFactory.initialize,
            (SyndicateFactory.InitParams({
                    owner: d.deployer,
                    executorImpl: d.executorLib,
                    vaultImpl: d.vaultImpl,
                    ensRegistrar: cfg.ensRegistrar,
                    agentRegistry: cfg.agentRegistry,
                    governor: d.governorProxy,
                    managementFeeBps: cfg.managementFeeBps,
                    guardianRegistry: d.registryProxy
                }))
        );
        return c3.deploy(
            SALT_FACTORY_PROXY, abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(factoryImpl, initData))
        );
    }

    function _deployRegistryProxy(
        Create3Factory c3,
        address registryImpl,
        address deployer,
        address governorProxy,
        address predictedFactoryProxy,
        Config memory cfg
    ) internal returns (address) {
        bytes memory initData = abi.encodeCall(
            GuardianRegistry.initialize,
            (
                deployer,
                governorProxy,
                predictedFactoryProxy,
                cfg.woodToken,
                DEFAULT_MIN_GUARDIAN_STAKE,
                DEFAULT_MIN_OWNER_STAKE,
                DEFAULT_COOLDOWN,
                DEFAULT_REVIEW_PERIOD,
                DEFAULT_BLOCK_QUORUM_BPS
            )
        );
        return c3.deploy(
            SALT_REGISTRY_PROXY, abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(registryImpl, initData))
        );
    }

    /// @dev Seeds the slash-appeal reserve and epoch-0 rewards when the
    ///      deployer holds WOOD. Skipped silently if either seed is 0 or the
    ///      balance is insufficient — testnet deploys without a WOOD balance
    ///      can top up post-deploy.
    function _seedRegistry(address deployer, address registryProxy, Config memory cfg) internal {
        IERC20 wood = IERC20(cfg.woodToken);
        uint256 bal = wood.balanceOf(deployer);
        uint256 total = cfg.slashAppealSeed + cfg.epochZeroSeed;
        if (bal < total) {
            console.log("Registry seed skipped: deployer WOOD balance %s < required %s", bal, total);
            return;
        }
        wood.approve(registryProxy, total);
        if (cfg.slashAppealSeed > 0) {
            GuardianRegistry(registryProxy).fundSlashAppealReserve(cfg.slashAppealSeed);
            console.log("SlashAppealReserve seeded:", cfg.slashAppealSeed);
        }
        // V1.5: epoch-0 seed removed — WOOD epoch block-rewards distributed
        // via Merkl off-chain. Protocol owner funds Merkl campaign directly
        // (transfer WOOD to merkl distributor) then calls `recordEpochBudget`
        // for the indexer event. Not scripted into Deploy to keep deployment
        // scope disjoint from off-chain reward infra.
        if (cfg.epochZeroSeed > 0) {
            console.log("Note: epochZeroSeed ignored (moved to Merkl):", cfg.epochZeroSeed);
        }
    }

    /// @dev Best-effort read of a chains/{chainId}.json key. Returns address(0)
    ///      when the file or key is missing — callers treat that as "use env".
    function _tryReadAddress(string memory key) internal view returns (address) {
        string memory path = string.concat(vm.projectRoot(), "/chains/", vm.toString(block.chainid), ".json");
        try vm.readFile(path) returns (string memory json) {
            try vm.parseJsonAddress(json, string.concat(".", key)) returns (address a) {
                return a;
            } catch {}
        } catch {}
        return address(0);
    }

    function _validateGovernor(address deployer, address governorAddr, address factoryAddr, uint256 maxDays)
        internal
        view
    {
        console.log("\n=== Validating Governor ===");
        SyndicateGovernor governor = SyndicateGovernor(governorAddr);
        ISyndicateGovernor.GovernorParams memory p = governor.getGovernorParams();

        _checkAddr("gov.owner", Ownable(governorAddr).owner(), deployer);
        _checkUint("gov.votingPeriod", p.votingPeriod, 1 days);
        _checkUint("gov.executionWindow", p.executionWindow, 1 days);
        _checkUint("gov.vetoThresholdBps", p.vetoThresholdBps, 4000);
        _checkUint("gov.maxPerformanceFeeBps", p.maxPerformanceFeeBps, 3000);
        _checkUint("gov.cooldownPeriod", p.cooldownPeriod, 1 days);
        _checkUint("gov.collaborationWindow", p.collaborationWindow, 48 hours);
        _checkUint("gov.maxCoProposers", p.maxCoProposers, 5);
        _checkUint("gov.minStrategyDuration", p.minStrategyDuration, 1 hours);
        _checkUint("gov.maxStrategyDuration", p.maxStrategyDuration, maxDays * 1 days);
        _checkUint("gov.protocolFeeBps", governor.protocolFeeBps(), 200);
        _checkAddr("gov.protocolFeeRecipient", governor.protocolFeeRecipient(), deployer);
        // V1.5: timelock removed — factory + guardian-fee recipient are set
        // directly in step 6. Validate the live values.
        _checkAddr("gov.factory", governor.factory(), factoryAddr);
        // V1.5: guardianFeeBps defaults to 0 at init (fee stream disabled
        // until the multisig is ready); recipient is wired to the registry
        // immediately so we can flip bps > 0 later with a single set call.
        _checkUint("gov.guardianFeeBps", governor.guardianFeeBps(), 0);
        // P1-1: recipient is pinned to `_guardianRegistry` — no separate
        // field to validate (registry validation below asserts the pointer).
    }

    function _validateFactory(
        address deployer,
        address governorAddr,
        address factoryAddr,
        address executorLibAddr,
        address vaultImplAddr,
        address ensRegistrar,
        address agentRegistry,
        uint256 mgmtFeeBps
    ) internal view {
        console.log("=== Validating Factory ===");
        SyndicateFactory factory = SyndicateFactory(factoryAddr);

        _checkAddr("factory.owner", Ownable(factoryAddr).owner(), deployer);
        _checkAddr("factory.governor", factory.governor(), governorAddr);
        _checkAddr("factory.executorImpl", factory.executorImpl(), executorLibAddr);
        _checkAddr("factory.vaultImpl", factory.vaultImpl(), vaultImplAddr);
        _checkAddr("factory.ensRegistrar", address(factory.ensRegistrar()), ensRegistrar);
        _checkAddr("factory.agentRegistry", address(factory.agentRegistry()), agentRegistry);
        _checkUint("factory.managementFeeBps", factory.managementFeeBps(), mgmtFeeBps);

        console.log("=== All checks passed ===");
    }

    function _validateRegistry(address registryAddr, address governorAddr, address factoryAddr, address wood)
        internal
        view
    {
        console.log("=== Validating GuardianRegistry ===");
        GuardianRegistry reg = GuardianRegistry(registryAddr);
        _checkAddr("registry.governor", reg.governor(), governorAddr);
        _checkAddr("registry.factory", reg.factory(), factoryAddr);
        _checkAddr("registry.wood", address(reg.wood()), wood);
        _checkUint("registry.minGuardianStake", reg.minGuardianStake(), DEFAULT_MIN_GUARDIAN_STAKE);
        _checkUint("registry.minOwnerStake", reg.minOwnerStake(), DEFAULT_MIN_OWNER_STAKE);
        _checkUint("registry.coolDownPeriod", reg.coolDownPeriod(), DEFAULT_COOLDOWN);
        _checkUint("registry.reviewPeriod", reg.reviewPeriod(), DEFAULT_REVIEW_PERIOD);
        _checkUint("registry.blockQuorumBps", reg.blockQuorumBps(), DEFAULT_BLOCK_QUORUM_BPS);
        // Governor knows about the registry (set at init-time).
        // P1-1: recipient is pinned to this same pointer — fees route here.
        _checkAddr("gov.guardianRegistry", SyndicateGovernor(governorAddr).guardianRegistry(), registryAddr);
    }

    function _chainName() internal view returns (string memory) {
        if (block.chainid == 8453) return "Base";
        if (block.chainid == 84532) return "Base Sepolia";
        if (block.chainid == 999) return "HyperEVM";
        if (block.chainid == 998) return "HyperEVM Testnet";
        if (block.chainid == 46630) return "Robinhood L2 Testnet";
        if (block.chainid == 42161) return "Arbitrum";
        return "Unknown";
    }
}
