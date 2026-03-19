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
 * @notice Deploy Sherwood protocol infrastructure to Robinhood L2 testnet.
 *
 *         Robinhood L2 is Arbitrum Orbit — no ENS/Durin or ERC-8004 agent
 *         identity registry. The factory is deployed with address(0) for both,
 *         which disables identity verification and ENS subname registration.
 *
 *   Usage:
 *     forge script script/robinhood-testnet/Deploy.s.sol:DeployRobinhoodTestnet \
 *       --rpc-url robinhood_testnet \
 *       --account sherwood-agent \
 *       --broadcast
 */
contract DeployRobinhoodTestnet is Script {
    // No ENS or ERC-8004 on Robinhood L2
    address constant L2_REGISTRAR = address(0);
    address constant AGENT_REGISTRY = address(0);

    function run() external {
        address deployer = msg.sender;

        console.log("Deployer:", deployer);
        console.log("Network: Robinhood L2 Testnet (chain ID 46630)");

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

        // 4. Deploy SyndicateFactory (no ENS registrar, no agent registry)
        SyndicateFactory factory =
            new SyndicateFactory(address(executorLib), address(vaultImpl), L2_REGISTRAR, AGENT_REGISTRY, governorProxy);
        console.log("SyndicateFactory:", address(factory));
        ISyndicateGovernor(governorProxy).setFactory(address(factory));

        // 5. Deploy StrategyRegistry (UUPS proxy)
        StrategyRegistry registryImpl = new StrategyRegistry();
        bytes memory registryInitData = abi.encodeCall(StrategyRegistry.initialize, (deployer, deployer));
        address registryProxy = address(new ERC1967Proxy(address(registryImpl), registryInitData));
        console.log("StrategyRegistry:", registryProxy);

        vm.stopBroadcast();

        // Summary
        console.log("\n=== Robinhood L2 Testnet Deployment Summary ===");
        console.log("FACTORY_ADDRESS=%s", address(factory));
        console.log("REGISTRY_ADDRESS=%s", registryProxy);
        console.log("GOVERNOR_ADDRESS=%s", governorProxy);
        console.log("EXECUTOR_LIB_ADDRESS=%s", address(executorLib));
        console.log("\nNote: No ENS or ERC-8004 on this chain.");
        console.log("Identity and attestations remain on Base.");
        console.log("\nNext steps:");
        console.log("  1. sherwood --chain robinhood-testnet syndicate create --subdomain <name> --name <name>");
        console.log("Explorer: https://explorer.testnet.chain.robinhood.com/address/%s", address(factory));
    }
}
