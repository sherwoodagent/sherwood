// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {ScriptBase} from "../ScriptBase.sol";
import {PortfolioStrategy} from "../../src/strategies/PortfolioStrategy.sol";
import {SynthraSwapAdapter} from "../../src/adapters/SynthraSwapAdapter.sol";

/**
 * @notice Deploy PortfolioStrategy template + SynthraSwapAdapter to Robinhood L2 testnet.
 *
 *   Prerequisites:
 *     - Synthra Router + Quoter addresses must be set below
 *     - Core protocol (factory, governor) already deployed via Deploy.s.sol
 *
 *   Usage:
 *     forge script script/robinhood-testnet/DeployBasketStrategy.s.sol:DeployBasketStrategy \
 *       --rpc-url robinhood_testnet \
 *       --account sherwood-agent \
 *       --broadcast
 */
contract DeployBasketStrategy is ScriptBase {
    // ── Synthra DEX addresses (from @synthra-swap/sdk-core@4.2.12) ──
    address constant SYNTHRA_ROUTER = 0x3Ce954107b1A675826B33bF23060Dd655e3758fE; // SwapRouter02
    address constant SYNTHRA_QUOTER = 0x231606c321A99DE81e28fE48B07a93F1ba49e713; // QuoterV2
    address constant SYNTHRA_FACTORY = 0x911b4000D3422F482F4062a913885f7b035382Df; // V3 Core Factory

    // ── Robinhood testnet stock tokens ──
    address constant TSLA = 0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E;
    address constant AMZN = 0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02;
    address constant PLTR = 0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0;
    address constant NFLX = 0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93;
    address constant AMD = 0x71178BAc73cBeb415514eB542a8995b82669778d;

    // ── Infrastructure ──
    address constant WETH = 0x7943e237c7F95DA44E0301572D358911207852Fa;
    address constant CHAINLINK_VERIFIER = 0x72790f9eB82db492a7DDb6d2af22A270Dcc3Db64;

    function run() external {
        // Synthra addresses are now set — no runtime checks needed

        vm.startBroadcast();

        address deployer = msg.sender;
        console.log("Deployer:", deployer);
        console.log("Network: Robinhood L2 Testnet (chain ID 46630)");

        // 1. Deploy SynthraSwapAdapter
        SynthraSwapAdapter adapter = new SynthraSwapAdapter(SYNTHRA_ROUTER, SYNTHRA_QUOTER);
        console.log("SynthraSwapAdapter:", address(adapter));

        // 2. Deploy PortfolioStrategy template (ERC-1167 clonable)
        PortfolioStrategy template = new PortfolioStrategy();
        console.log("PortfolioStrategy template:", address(template));

        vm.stopBroadcast();

        console.log("\n=== Deployment Summary ===");
        console.log("SynthraSwapAdapter:          ", address(adapter));
        console.log("PortfolioStrategy template:", address(template));
        console.log("\nStock tokens available:");
        console.log("  TSLA:", TSLA);
        console.log("  AMZN:", AMZN);
        console.log("  PLTR:", PLTR);
        console.log("  NFLX:", NFLX);
        console.log("  AMD: ", AMD);
        console.log("\nChainlink Verifier:", CHAINLINK_VERIFIER);
        console.log("\nNext: update contracts/chains/46630.json with new addresses");
    }
}
