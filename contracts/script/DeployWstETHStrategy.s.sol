// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {WstETHMoonwellStrategy} from "../src/strategies/WstETHMoonwellStrategy.sol";

/**
 * @notice Deploy WstETHMoonwellStrategy template to Base.
 *         This is the template contract — clones are created per-proposal.
 *
 *   Usage:
 *     forge script script/DeployWstETHStrategy.s.sol:DeployWstETHStrategy \
 *       --rpc-url https://rpc.moonwell.fi/main/evm/8453 \
 *       --private-key $SHERWOOD_PRIVATE_KEY \
 *       --broadcast \
 *       --verify \
 *       --verifier-url https://api.basescan.org/api \
 *       --etherscan-api-key $BASESCAN_API_KEY
 */
contract DeployWstETHStrategy is Script {
    function run() external {
        address deployer = msg.sender;
        console.log("Deployer:", deployer);

        vm.startBroadcast();

        WstETHMoonwellStrategy strategy = new WstETHMoonwellStrategy();
        console.log("WstETHMoonwellStrategy template:", address(strategy));

        vm.stopBroadcast();
    }
}
