// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SyndicateVault} from "../../src/SyndicateVault.sol";
import {ISyndicateVault} from "../../src/interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "../../src/BatchExecutorLib.sol";
import {SyndicateFactory} from "../../src/SyndicateFactory.sol";
import {StrategyRegistry} from "../../src/StrategyRegistry.sol";

/**
 * @notice Deploy Sherwood infrastructure to Base Sepolia (testnet):
 *         1. BatchExecutorLib (shared, stateless)
 *         2. SyndicateVault implementation
 *         3. SyndicateFactory (registers both)
 *         4. StrategyRegistry (UUPS proxy)
 *         5. First syndicate via factory
 *         6. Register deployer as agent + sample strategy
 *
 *   Usage:
 *     forge script script/testnet/Deploy.s.sol:DeployTestnet \
 *       --rpc-url base_sepolia \
 *       --private-key $PRIVATE_KEY \
 *       --broadcast
 */
contract DeployTestnet is Script {
    // ── Base Sepolia addresses ──

    // Circle test USDC on Base Sepolia (6 decimals)
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    // Canonical WETH (same on all Base networks)
    address constant WETH = 0x4200000000000000000000000000000000000006;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:", deployer);
        console.log("Network: Base Sepolia (testnet)");

        vm.startBroadcast(deployerKey);

        // 1. Deploy BatchExecutorLib (shared, stateless)
        BatchExecutorLib executorLib = new BatchExecutorLib();
        console.log("BatchExecutorLib:", address(executorLib));

        // 2. Deploy SyndicateVault implementation
        SyndicateVault vaultImpl = new SyndicateVault();
        console.log("Vault implementation:", address(vaultImpl));

        // 3. Deploy SyndicateFactory
        SyndicateFactory factory = new SyndicateFactory(address(executorLib), address(vaultImpl));
        console.log("SyndicateFactory:", address(factory));

        // 4. Deploy StrategyRegistry (UUPS proxy)
        StrategyRegistry registryImpl = new StrategyRegistry();
        bytes memory registryInitData = abi.encodeCall(StrategyRegistry.initialize, (deployer, deployer));
        address registryProxy = address(new ERC1967Proxy(address(registryImpl), registryInitData));
        console.log("StrategyRegistry:", registryProxy);

        // 5. Create first syndicate via factory
        // Testnet: only USDC and WETH as targets (protocols may not be on Sepolia)
        address[] memory targets = new address[](2);
        targets[0] = USDC;
        targets[1] = WETH;

        (uint256 syndicateId, address vaultProxy) = factory.createSyndicate(
            SyndicateFactory.SyndicateConfig({
                metadataURI: "",
                asset: IERC20(USDC),
                name: "Sherwood Testnet Vault",
                symbol: "shUSDC",
                caps: ISyndicateVault.SyndicateCaps({
                    maxPerTx: 100e6, // 100 USDC
                    maxDailyTotal: 500e6, // 500 USDC
                    maxBorrowRatio: 7500 // 75% LTV
                }),
                initialTargets: targets,
                openDeposits: true // Open for easy testing
            })
        );
        console.log("Syndicate #%d vault:", syndicateId, vaultProxy);

        // 6. Register deployer as agent (dev mode)
        SyndicateVault(payable(vaultProxy))
            .registerAgent(
                deployer, // pkpAddress (dev: deployer acts as agent)
                deployer, // operatorEOA
                100e6, // maxPerTx: 100 USDC
                500e6 // dailyLimit: 500 USDC
            );
        console.log("Registered deployer as agent");

        // 7. Register sample strategy
        StrategyRegistry(registryProxy)
            .registerStrategy(
                address(0xdead), // Placeholder implementation
                1, // Type 1 = lending
                "levered-swap",
                "" // No metadata URI yet
            );
        console.log("Registered sample strategy");

        vm.stopBroadcast();

        // Summary
        console.log("\n=== Testnet Deployment Summary ===");
        console.log("VAULT_ADDRESS_TESTNET=%s", vaultProxy);
        console.log("FACTORY_ADDRESS_TESTNET=%s", address(factory));
        console.log("REGISTRY_ADDRESS_TESTNET=%s", registryProxy);
        console.log("EXECUTOR_LIB_ADDRESS=%s", address(executorLib));
        console.log("\nCopy the above to cli/.env");
        console.log("Explorer: https://sepolia.basescan.org/address/%s", address(factory));
    }
}
