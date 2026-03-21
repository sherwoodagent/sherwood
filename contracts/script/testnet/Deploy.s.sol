// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {SyndicateFactory} from "../../src/SyndicateFactory.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";

/**
 * @notice Deploy Sherwood protocol infrastructure to Base Sepolia (testnet).
 *         This script deploys only the shared infrastructure contracts:
 *         1. BatchExecutorLib (shared, stateless)
 *         2. SyndicateVault implementation
 *         3. SyndicateGovernor (UUPS proxy)
 *         4. SyndicateFactory (registers both)
 *
 *         Syndicate creation and agent registration are handled via the CLI
 *         after deployment:
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
                    vetoThresholdBps: 4000,
                    maxPerformanceFeeBps: 3000,
                    cooldownPeriod: 1 days,
                    collaborationWindow: 48 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 hours,
                    maxStrategyDuration: 30 days,
                    parameterChangeDelay: 1 days,
                    protocolFeeBps: 200,
                    protocolFeeRecipient: deployer
                }))
        );
        address governorProxy = address(new ERC1967Proxy(address(govImpl), govInitData));
        console.log("SyndicateGovernor:", governorProxy);

        // 4. Deploy SyndicateFactory (UUPS proxy)
        SyndicateFactory factoryImpl = new SyndicateFactory();
        bytes memory factoryInitData = abi.encodeCall(
            SyndicateFactory.initialize,
            (SyndicateFactory.InitParams({
                    owner: deployer,
                    executorImpl: address(executorLib),
                    vaultImpl: address(vaultImpl),
                    ensRegistrar: L2_REGISTRAR,
                    agentRegistry: AGENT_REGISTRY,
                    governor: governorProxy,
                    managementFeeBps: 50
                }))
        );
        SyndicateFactory factory = SyndicateFactory(address(new ERC1967Proxy(address(factoryImpl), factoryInitData)));
        console.log("SyndicateFactory:", address(factory));

        vm.stopBroadcast();

        // Summary
        console.log("\n=== Testnet Deployment Summary ===");
        console.log("FACTORY_ADDRESS_TESTNET=%s", address(factory));
        console.log("EXECUTOR_LIB_ADDRESS=%s", address(executorLib));
        console.log("\nCopy the above to cli/.env");
        console.log("\nNext steps:");
        console.log("  1. sherwood --testnet identity mint");
        console.log("  2. sherwood --testnet syndicate create --agent-id <id> --subdomain <name> --name <name>");
        console.log("Explorer: https://sepolia.basescan.org/address/%s", address(factory));
    }
}
