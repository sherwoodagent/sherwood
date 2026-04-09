// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {ScriptBase} from "./ScriptBase.sol";
import {PortfolioStrategy} from "../src/strategies/PortfolioStrategy.sol";
import {UniswapSwapAdapter} from "../src/adapters/UniswapSwapAdapter.sol";

/**
 * @notice Deploy UniswapSwapAdapter + PortfolioStrategy template to Base mainnet.
 *
 *   Prerequisites:
 *     - Uniswap V3 Router + QuoterV2 addresses set below
 *     - Core protocol (factory, governor) already deployed via Deploy.s.sol
 *
 *   Usage:
 *     forge script script/DeployPortfolioStrategy.s.sol:DeployPortfolioStrategy \
 *       --rpc-url base \
 *       --account sherwood-agent \
 *       --broadcast
 */
contract DeployPortfolioStrategy is ScriptBase {
    // ── Uniswap V3 addresses (Base mainnet) ──
    address constant UNISWAP_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481; // SwapRouter02
    address constant UNISWAP_QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a; // QuoterV2

    // ── Chainlink Data Streams (Base mainnet) ──
    address constant CHAINLINK_VERIFIER = 0xDE1A28D87Afd0f546505B28AB50410A5c3a7387a;

    function run() external {
        vm.startBroadcast();

        address deployer = msg.sender;
        console.log("Deployer:", deployer);
        console.log("Network: Base mainnet (chain ID 8453)");

        // 1. Deploy UniswapSwapAdapter
        UniswapSwapAdapter adapter = new UniswapSwapAdapter(UNISWAP_V3_ROUTER, UNISWAP_QUOTER_V2);
        console.log("UniswapSwapAdapter:", address(adapter));

        // 2. Deploy PortfolioStrategy template (ERC-1167 clonable)
        PortfolioStrategy template = new PortfolioStrategy();
        console.log("PortfolioStrategy template:", address(template));

        vm.stopBroadcast();

        console.log("\n=== Deployment Summary ===");
        console.log("UniswapSwapAdapter:        ", address(adapter));
        console.log("PortfolioStrategy template:", address(template));
        console.log("Chainlink Verifier:        ", CHAINLINK_VERIFIER);
        console.log("\nNext steps:");
        console.log("  1. Update contracts/chains/8453.json with:");
        console.log("     UNISWAP_SWAP_ADAPTER:", address(adapter));
        console.log("     PORTFOLIO_STRATEGY:", address(template));
        console.log("  2. Update cli/src/lib/addresses.ts");
    }
}
