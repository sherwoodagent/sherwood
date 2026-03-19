// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {SyndicateFactory} from "../../src/SyndicateFactory.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {StrategyRegistry} from "../../src/StrategyRegistry.sol";

/**
 * @notice Deploy Sherwood protocol infrastructure to Base Sepolia (testnet).
 *         This script deploys only the shared infrastructure contracts:
 *         1. BatchExecutorLib (shared, stateless)
 *         2. SyndicateVault implementation
 *         3. SyndicateFactory (registers both)
 *         4. StrategyRegistry (UUPS proxy)
 *
 *         Syndicate creation, agent registration, and strategy registration
 *         are handled via the CLI after deployment:
 *           sherwood identity mint
 *           sherwood syndicate create --agent-id <id> ...
 *           sherwood syndicate add --vault <addr> ...
 *
 *   Usage:
 *     forge script script/testnet/Deploy.s.sol:DeployTestnet \
 *       --rpc-url base_sepolia \
 *       --account sherwood-agent \
 *       --broadcast
 */
contract DeployTestnet is Script {
    // ── Base Sepolia addresses ──

    // Durin L2 Registrar (ENS subnames for sherwoodagent.eth)
    address constant L2_REGISTRAR = 0x1fCbe9dFC25e3fa3F7C55b26c7992684A4758b47;

    // ERC-8004 Agent Identity Registry (Base Sepolia)
    address constant AGENT_REGISTRY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;

    function run() external {
        // Use --account flag (keystore) instead of raw PRIVATE_KEY
        address deployer = msg.sender;

        console.log("Deployer:", deployer);
        console.log("Network: Base Sepolia (testnet)");

        vm.startBroadcast();

        // 1. Deploy BatchExecutorLib (shared, stateless)
        BatchExecutorLib executorLib = new BatchExecutorLib();
        console.log("BatchExecutorLib:", address(executorLib));

        // 2. Deploy SyndicateVault implementation
        SyndicateVault vaultImpl = new SyndicateVault();
        console.log("Vault implementation:", address(vaultImpl));

        // 3. Deploy SyndicateGovernor (UUPS proxy)
        SyndicateGovernor govImpl = new SyndicateGovernor();
        bytes memory govInitData = abi.encodeCall(
            SyndicateGovernor.initialize,
            (ISyndicateGovernor.InitParams({
                    owner: deployer,
                    votingPeriod: 1 days,
                    executionWindow: 1 days,
                    quorumBps: 4000,
                    maxPerformanceFeeBps: 3000,
                    cooldownPeriod: 1 days,
                    collaborationWindow: 48 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 days,
                    maxStrategyDuration: 7 days
                }))
        );
        address governorProxy = address(new ERC1967Proxy(address(govImpl), govInitData));
        console.log("SyndicateGovernor:", governorProxy);

        // 4. Deploy SyndicateFactory
        SyndicateFactory factory =
            new SyndicateFactory(address(executorLib), address(vaultImpl), L2_REGISTRAR, AGENT_REGISTRY, governorProxy);
        console.log("SyndicateFactory:", address(factory));

        // Authorize factory to register new vaults on governor
        ISyndicateGovernor(governorProxy).setFactory(address(factory));

        // 4. Deploy StrategyRegistry (UUPS proxy)
        StrategyRegistry registryImpl = new StrategyRegistry();
        bytes memory registryInitData = abi.encodeCall(StrategyRegistry.initialize, (deployer, deployer));
        address registryProxy = address(new ERC1967Proxy(address(registryImpl), registryInitData));
        console.log("StrategyRegistry:", registryProxy);

        vm.stopBroadcast();

        // Summary
        console.log("\n=== Testnet Deployment Summary ===");
        console.log("FACTORY_ADDRESS_TESTNET=%s", address(factory));
        console.log("REGISTRY_ADDRESS_TESTNET=%s", registryProxy);
        console.log("EXECUTOR_LIB_ADDRESS=%s", address(executorLib));
        console.log("\nCopy the above to cli/.env");
        console.log("\nNext steps:");
        console.log("  1. sherwood --testnet identity mint");
        console.log("  2. sherwood --testnet syndicate create --agent-id <id> --subdomain <name> --name <name>");
        console.log("Explorer: https://sepolia.basescan.org/address/%s", address(factory));
    }
}
