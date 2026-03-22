// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ScriptBase} from "./ScriptBase.sol";
import {MoonwellSupplyStrategy} from "../src/strategies/MoonwellSupplyStrategy.sol";
import {AerodromeLPStrategy} from "../src/strategies/AerodromeLPStrategy.sol";
import {VeniceInferenceStrategy} from "../src/strategies/VeniceInferenceStrategy.sol";
import {console} from "forge-std/console.sol";

/// @notice Deploy strategy template singletons (one-time per chain).
///         Templates are ERC-1167 clonable — each proposal clones and initializes.
///         Appends addresses to existing chains/{chainId}.json.
contract DeployTemplates is ScriptBase {
    function run() external {
        vm.startBroadcast();

        MoonwellSupplyStrategy moonwell = new MoonwellSupplyStrategy();
        AerodromeLPStrategy aerodrome = new AerodromeLPStrategy();
        VeniceInferenceStrategy venice = new VeniceInferenceStrategy();

        vm.stopBroadcast();

        console.log("MoonwellSupplyStrategy:    %s", address(moonwell));
        console.log("AerodromeLPStrategy:       %s", address(aerodrome));
        console.log("VeniceInferenceStrategy:   %s", address(venice));

        // Append template addresses to existing chains/{chainId}.json
        string memory path =
            string.concat(vm.projectRoot(), "/chains/", vm.toString(block.chainid), ".json");

        vm.writeJson(vm.toString(address(moonwell)), path, ".MOONWELL_SUPPLY_TEMPLATE");
        vm.writeJson(vm.toString(address(aerodrome)), path, ".AERODROME_LP_TEMPLATE");
        vm.writeJson(vm.toString(address(venice)), path, ".VENICE_INFERENCE_TEMPLATE");

        console.log("Template addresses appended to %s", path);
    }
}
