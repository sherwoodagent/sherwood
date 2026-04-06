// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {SyndicateFactory} from "../../src/SyndicateFactory.sol";
import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {ScriptBase} from "../ScriptBase.sol";

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
contract DeployRobinhoodTestnet is ScriptBase {
    // No ENS or ERC-8004 on Robinhood L2
    address constant L2_REGISTRAR = address(0);
    address constant AGENT_REGISTRY = address(0);

    function run() external {
        vm.startBroadcast();

        address deployer = msg.sender;
        console.log("Deployer:", deployer);
        console.log("Network: Robinhood L2 Testnet (chain ID 46630)");

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
                    votingPeriod: 1 hours,
                    executionWindow: 1 days,
                    vetoThresholdBps: 4000,
                    maxPerformanceFeeBps: 3000,
                    cooldownPeriod: 1 hours,
                    collaborationWindow: 48 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 hours,
                    maxStrategyDuration: 7 days,
                    parameterChangeDelay: 1 days,
                    protocolFeeBps: 200,
                    protocolFeeRecipient: deployer
                }))
        );
        address governorProxy = address(new ERC1967Proxy(address(govImpl), govInitData));
        console.log("SyndicateGovernor:", governorProxy);

        // 4. Deploy SyndicateFactory (UUPS proxy, no ENS registrar, no agent registry)
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

        // 5. Register factory on governor so addVault() works during createSyndicate
        SyndicateGovernor(governorProxy).setFactory(address(factory));
        console.log("Governor.setFactory:", address(factory));

        vm.stopBroadcast();

        // ── Validate on-chain state matches expected values ──
        _validate(deployer, governorProxy, address(factory), address(executorLib), address(vaultImpl));

        // ── Persist addresses to chains/{chainId}.json ──
        _writeAddresses(
            "Robinhood L2 Testnet", deployer, address(factory), governorProxy, address(executorLib), address(vaultImpl)
        );

        console.log("\nNote: No ENS or ERC-8004 on this chain.");
        console.log("Identity and attestations remain on Base.");
        console.log("\nNext steps:");
        console.log("  1. sherwood --chain robinhood-testnet syndicate create --subdomain <name> --name <name>");
        console.log("Explorer: https://explorer.testnet.chain.robinhood.com/address/%s", address(factory));
    }

    function _validate(
        address deployer,
        address governorAddr,
        address factoryAddr,
        address executorLibAddr,
        address vaultImplAddr
    ) internal view {
        console.log("\n=== Validating on-chain state ===");

        SyndicateGovernor governor = SyndicateGovernor(governorAddr);
        SyndicateFactory factory = SyndicateFactory(factoryAddr);

        // ── Governor ──
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
        // Note: Robinhood uses 7 days max (not 30 days like Base)
        _checkUint("gov.maxStrategyDuration", p.maxStrategyDuration, 7 days);
        _checkUint("gov.protocolFeeBps", governor.protocolFeeBps(), 200);
        _checkAddr("gov.protocolFeeRecipient", governor.protocolFeeRecipient(), deployer);

        // ── Factory ──
        _checkAddr("factory.owner", Ownable(factoryAddr).owner(), deployer);
        _checkAddr("factory.governor", factory.governor(), governorAddr);
        _checkAddr("factory.executorImpl", factory.executorImpl(), executorLibAddr);
        _checkAddr("factory.vaultImpl", factory.vaultImpl(), vaultImplAddr);
        // No ENS or agent registry on Robinhood L2 — expect address(0)
        _checkAddr("factory.ensRegistrar", address(factory.ensRegistrar()), address(0));
        _checkAddr("factory.agentRegistry", address(factory.agentRegistry()), address(0));
        _checkUint("factory.managementFeeBps", factory.managementFeeBps(), 50);

        console.log("=== All checks passed ===");
    }
}
