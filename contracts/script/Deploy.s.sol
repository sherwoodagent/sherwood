// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Create3} from "../src/Create3.sol";
import {SyndicateVault} from "../src/SyndicateVault.sol";
import {BatchExecutorLib} from "../src/BatchExecutorLib.sol";
import {SyndicateFactory} from "../src/SyndicateFactory.sol";
import {SyndicateGovernor} from "../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../src/interfaces/ISyndicateGovernor.sol";
import {ScriptBase} from "./ScriptBase.sol";

/**
 * @notice Generic Sherwood protocol deployment via CREATE3.
 *
 *         Works on any EVM chain. Deterministic addresses based on
 *         (deployer, salt) — same deployer + same salts = same addresses
 *         on Base, HyperEVM, Arbitrum, or any future chain.
 *
 *         Chain-specific features (ENS, ERC-8004) are passed via env vars.
 *         If not set, they default to address(0) (disabled).
 *
 *   Environment variables:
 *     ENS_REGISTRAR     — L2 Registrar address (default: 0x0 = no ENS)
 *     AGENT_REGISTRY    — ERC-8004 Identity Registry (default: 0x0 = no identity)
 *     MANAGEMENT_FEE    — Management fee in bps (default: 50 = 0.5%)
 *     PROTOCOL_FEE      — Protocol fee in bps (default: 200 = 2%)
 *     MAX_STRATEGY_DAYS — Max strategy duration in days (default: 30)
 *
 *   Usage:
 *     # HyperEVM (no ENS, no identity)
 *     forge script script/Deploy.s.sol:DeploySherwood \
 *       --rpc-url hyperevm --account <acct> --sender <addr> --broadcast
 *
 *     # Base (with ENS + identity)
 *     ENS_REGISTRAR=0x866996c808E6244216a3d0df15464FCF5d495394 \
 *     AGENT_REGISTRY=0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 \
 *       forge script script/Deploy.s.sol:DeploySherwood \
 *       --rpc-url base --account <acct> --sender <addr> --broadcast --verify
 */
contract DeploySherwood is ScriptBase {
    // ── CREATE3 salts ──
    bytes32 constant SALT_EXECUTOR = keccak256("sherwood.executor.mainnet");
    bytes32 constant SALT_VAULT_IMPL = keccak256("sherwood.vault-impl.mainnet");
    bytes32 constant SALT_GOVERNOR_IMPL = keccak256("sherwood.governor-impl.mainnet");
    bytes32 constant SALT_GOVERNOR_PROXY = keccak256("sherwood.governor-proxy.mainnet");
    bytes32 constant SALT_FACTORY_IMPL = keccak256("sherwood.factory-impl.mainnet");
    bytes32 constant SALT_FACTORY_PROXY = keccak256("sherwood.factory-proxy.mainnet");

    struct Config {
        address ensRegistrar;
        address agentRegistry;
        uint256 managementFeeBps;
        uint256 protocolFeeBps;
        uint256 maxStrategyDays;
    }

    struct Deployed {
        address deployer;
        address executorLib;
        address vaultImpl;
        address governorProxy;
        address factoryProxy;
    }

    function run() external {
        Config memory cfg = Config({
            ensRegistrar: vm.envOr("ENS_REGISTRAR", address(0)),
            agentRegistry: vm.envOr("AGENT_REGISTRY", address(0)),
            managementFeeBps: vm.envOr("MANAGEMENT_FEE", uint256(50)),
            protocolFeeBps: vm.envOr("PROTOCOL_FEE", uint256(200)),
            maxStrategyDays: vm.envOr("MAX_STRATEGY_DAYS", uint256(30))
        });

        vm.startBroadcast();

        Deployed memory d;
        d.deployer = msg.sender;
        console.log("Deployer:", d.deployer);
        console.log("Chain ID:", block.chainid);
        console.log("ENS Registrar:", cfg.ensRegistrar);
        console.log("Agent Registry:", cfg.agentRegistry);

        // 1. BatchExecutorLib
        d.executorLib = Create3.deploy(SALT_EXECUTOR, abi.encodePacked(type(BatchExecutorLib).creationCode));
        console.log("\nBatchExecutorLib:", d.executorLib);

        // 2. SyndicateVault implementation
        d.vaultImpl = Create3.deploy(SALT_VAULT_IMPL, abi.encodePacked(type(SyndicateVault).creationCode));
        console.log("VaultImpl:", d.vaultImpl);

        // 3. SyndicateGovernor implementation + proxy
        address govImpl =
            Create3.deploy(SALT_GOVERNOR_IMPL, abi.encodePacked(type(SyndicateGovernor).creationCode));
        d.governorProxy = _deployGovernorProxy(govImpl, d.deployer, cfg);
        console.log("GovernorProxy:", d.governorProxy);

        // 4. SyndicateFactory implementation + proxy
        address factoryImpl =
            Create3.deploy(SALT_FACTORY_IMPL, abi.encodePacked(type(SyndicateFactory).creationCode));
        d.factoryProxy = _deployFactoryProxy(factoryImpl, d, cfg);
        console.log("FactoryProxy:", d.factoryProxy);

        // 5. Register factory on governor
        SyndicateGovernor(d.governorProxy).setFactory(d.factoryProxy);
        console.log("Governor.setFactory done");

        vm.stopBroadcast();

        // ── Validate ──
        _validateGovernor(d.deployer, d.governorProxy, d.factoryProxy, cfg.maxStrategyDays);
        _validateFactory(d.deployer, d.governorProxy, d.factoryProxy, d.executorLib, d.vaultImpl,
            cfg.ensRegistrar, cfg.agentRegistry, cfg.managementFeeBps);

        // ── Persist ──
        _writeAddresses(_chainName(), d.deployer, d.factoryProxy, d.governorProxy, d.executorLib, d.vaultImpl);

        console.log("\nDeployment complete on %s (chain %s)", _chainName(), block.chainid);
        console.log("Next: forge script script/DeployTemplates.s.sol --rpc-url <chain> --broadcast");
    }

    function _deployGovernorProxy(address govImpl, address deployer, Config memory cfg)
        internal
        returns (address)
    {
        bytes memory initData = abi.encodeCall(
            SyndicateGovernor.initialize,
            (
                ISyndicateGovernor.InitParams({
                    owner: deployer,
                    votingPeriod: 1 hours,
                    executionWindow: 1 days,
                    vetoThresholdBps: 4000,
                    maxPerformanceFeeBps: 3000,
                    cooldownPeriod: 1 hours,
                    collaborationWindow: 48 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 hours,
                    maxStrategyDuration: cfg.maxStrategyDays * 1 days,
                    parameterChangeDelay: 1 days,
                    protocolFeeBps: cfg.protocolFeeBps,
                    protocolFeeRecipient: deployer
                })
            )
        );
        return Create3.deploy(
            SALT_GOVERNOR_PROXY,
            abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(govImpl, initData))
        );
    }

    function _deployFactoryProxy(address factoryImpl, Deployed memory d, Config memory cfg)
        internal
        returns (address)
    {
        bytes memory initData = abi.encodeCall(
            SyndicateFactory.initialize,
            (
                SyndicateFactory.InitParams({
                    owner: d.deployer,
                    executorImpl: d.executorLib,
                    vaultImpl: d.vaultImpl,
                    ensRegistrar: cfg.ensRegistrar,
                    agentRegistry: cfg.agentRegistry,
                    governor: d.governorProxy,
                    managementFeeBps: cfg.managementFeeBps
                })
            )
        );
        return Create3.deploy(
            SALT_FACTORY_PROXY,
            abi.encodePacked(type(ERC1967Proxy).creationCode, abi.encode(factoryImpl, initData))
        );
    }

    function _validateGovernor(address deployer, address governorAddr, address factoryAddr, uint256 maxDays)
        internal
        view
    {
        console.log("\n=== Validating Governor ===");
        SyndicateGovernor governor = SyndicateGovernor(governorAddr);
        ISyndicateGovernor.GovernorParams memory p = governor.getGovernorParams();

        _checkAddr("gov.owner", Ownable(governorAddr).owner(), deployer);
        _checkUint("gov.votingPeriod", p.votingPeriod, 1 hours);
        _checkUint("gov.executionWindow", p.executionWindow, 1 days);
        _checkUint("gov.vetoThresholdBps", p.vetoThresholdBps, 4000);
        _checkUint("gov.maxPerformanceFeeBps", p.maxPerformanceFeeBps, 3000);
        _checkUint("gov.cooldownPeriod", p.cooldownPeriod, 1 hours);
        _checkUint("gov.collaborationWindow", p.collaborationWindow, 48 hours);
        _checkUint("gov.maxCoProposers", p.maxCoProposers, 5);
        _checkUint("gov.minStrategyDuration", p.minStrategyDuration, 1 hours);
        _checkUint("gov.maxStrategyDuration", p.maxStrategyDuration, maxDays * 1 days);
        _checkUint("gov.protocolFeeBps", governor.protocolFeeBps(), 200);
        _checkAddr("gov.protocolFeeRecipient", governor.protocolFeeRecipient(), deployer);
        _checkAddr("gov.factory", governor.factory(), factoryAddr);
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
