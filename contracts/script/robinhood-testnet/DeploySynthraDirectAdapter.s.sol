// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SynthraDirectAdapter} from "../../src/adapters/SynthraDirectAdapter.sol";

/**
 * @notice Deploy SynthraDirectAdapter (bypasses router, uses pool.swap() directly).
 *
 *   Usage:
 *     forge script script/robinhood-testnet/DeploySynthraDirectAdapter.s.sol:DeploySynthraDirectAdapterScript \
 *       --rpc-url robinhood_testnet \
 *       --account sherwood-agent \
 *       --broadcast
 */
contract DeploySynthraDirectAdapterScript is Script {
    address constant SYNTHRA_FACTORY = 0x911b4000D3422F482F4062a913885f7b035382Df;

    function run() external {
        vm.startBroadcast();

        SynthraDirectAdapter adapter = new SynthraDirectAdapter(SYNTHRA_FACTORY);
        console.log("SynthraDirectAdapter:", address(adapter));

        vm.stopBroadcast();

        // Update chains JSON
        string memory path = string.concat(vm.projectRoot(), "/chains/", vm.toString(block.chainid), ".json");
        vm.writeJson(vm.toString(address(adapter)), path, ".SYNTHRA_DIRECT_ADAPTER");
        console.log("Updated chains JSON");
    }
}
