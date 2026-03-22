// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ScriptBase} from "./ScriptBase.sol";
import {console} from "forge-std/console.sol";
import {IStrategy} from "../src/interfaces/IStrategy.sol";
import {MoonwellSupplyStrategy} from "../src/strategies/MoonwellSupplyStrategy.sol";
import {AerodromeLPStrategy} from "../src/strategies/AerodromeLPStrategy.sol";
import {VeniceInferenceStrategy} from "../src/strategies/VeniceInferenceStrategy.sol";
import {WstETHMoonwellStrategy} from "../src/strategies/WstETHMoonwellStrategy.sol";

/**
 * @notice Deploy strategy template singletons (one-time per chain).
 *         Templates are ERC-1167 clonable — each proposal clones and initializes.
 *
 *         Skips templates already deployed (address exists in chains/{chainId}.json).
 *         Appends new addresses and validates all templates after deployment.
 *
 *   Usage:
 *     forge script script/DeployTemplates.s.sol:DeployTemplates \
 *       --rpc-url base --broadcast --account sherwood-agent
 *
 *   Dry run (no broadcast):
 *     forge script script/DeployTemplates.s.sol:DeployTemplates --rpc-url base
 */
contract DeployTemplates is ScriptBase {
    string constant MOONWELL_KEY = "MOONWELL_SUPPLY_TEMPLATE";
    string constant AERODROME_KEY = "AERODROME_LP_TEMPLATE";
    string constant VENICE_KEY = "VENICE_INFERENCE_TEMPLATE";
    string constant WSTETH_KEY = "WSTETH_MOONWELL_TEMPLATE";

    function run() external {
        string memory path = string.concat(vm.projectRoot(), "/chains/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);

        // ── 1. Check which templates are already deployed ──

        address moonwellAddr = _tryReadAddress(json, MOONWELL_KEY);
        address aerodromeAddr = _tryReadAddress(json, AERODROME_KEY);
        address veniceAddr = _tryReadAddress(json, VENICE_KEY);
        address wstethAddr = _tryReadAddress(json, WSTETH_KEY);

        // Verify addresses actually have code on-chain (catches stale dry-run addresses)
        bool needMoonwell = moonwellAddr == address(0) || moonwellAddr.code.length == 0;
        bool needAerodrome = aerodromeAddr == address(0) || aerodromeAddr.code.length == 0;
        bool needVenice = veniceAddr == address(0) || veniceAddr.code.length == 0;
        bool needWsteth = wstethAddr == address(0) || wstethAddr.code.length == 0;

        bool anyDeployed = false;

        console.log("\n=== Strategy Template Deployment ===\n");

        // ── 2. Deploy missing templates ──

        vm.startBroadcast();

        if (needMoonwell) {
            if (moonwellAddr != address(0)) {
                console.log("  Stale    MoonwellSupplyStrategy:   %s (no code, redeploying)", moonwellAddr);
            }
            MoonwellSupplyStrategy moonwell = new MoonwellSupplyStrategy();
            moonwellAddr = address(moonwell);
            console.log("  Deployed MoonwellSupplyStrategy:   %s", moonwellAddr);
            anyDeployed = true;
        } else {
            console.log("  Skipped  MoonwellSupplyStrategy:   %s (already deployed)", moonwellAddr);
        }

        if (needAerodrome) {
            if (aerodromeAddr != address(0)) {
                console.log("  Stale    AerodromeLPStrategy:      %s (no code, redeploying)", aerodromeAddr);
            }
            AerodromeLPStrategy aerodrome = new AerodromeLPStrategy();
            aerodromeAddr = address(aerodrome);
            console.log("  Deployed AerodromeLPStrategy:      %s", aerodromeAddr);
            anyDeployed = true;
        } else {
            console.log("  Skipped  AerodromeLPStrategy:      %s (already deployed)", aerodromeAddr);
        }

        if (needVenice) {
            if (veniceAddr != address(0)) {
                console.log("  Stale    VeniceInferenceStrategy:  %s (no code, redeploying)", veniceAddr);
            }
            VeniceInferenceStrategy venice = new VeniceInferenceStrategy();
            veniceAddr = address(venice);
            console.log("  Deployed VeniceInferenceStrategy:  %s", veniceAddr);
            anyDeployed = true;
        } else {
            console.log("  Skipped  VeniceInferenceStrategy:  %s (already deployed)", veniceAddr);
        }

        if (needWsteth) {
            if (wstethAddr != address(0)) {
                console.log("  Stale    WstETHMoonwellStrategy:   %s (no code, redeploying)", wstethAddr);
            }
            WstETHMoonwellStrategy wsteth = new WstETHMoonwellStrategy();
            wstethAddr = address(wsteth);
            console.log("  Deployed WstETHMoonwellStrategy:   %s", wstethAddr);
            anyDeployed = true;
        } else {
            console.log("  Skipped  WstETHMoonwellStrategy:   %s (already deployed)", wstethAddr);
        }

        vm.stopBroadcast();

        // ── 3. Save addresses ──

        if (anyDeployed) {
            vm.writeJson(vm.toString(moonwellAddr), path, string.concat(".", MOONWELL_KEY));
            vm.writeJson(vm.toString(aerodromeAddr), path, string.concat(".", AERODROME_KEY));
            vm.writeJson(vm.toString(veniceAddr), path, string.concat(".", VENICE_KEY));
            vm.writeJson(vm.toString(wstethAddr), path, string.concat(".", WSTETH_KEY));
            console.log("\n  Addresses saved to %s", path);
        } else {
            console.log("\n  All templates already deployed, nothing to save.");
        }

        // ── 4. Validate ──

        console.log("\n=== Validation ===\n");
        _validate(moonwellAddr, aerodromeAddr, veniceAddr, wstethAddr);
        console.log("\n  All validations passed.\n");
    }

    // ── Helpers ──

    /// @notice Try to read an address from JSON; return address(0) if key missing or zero.
    function _tryReadAddress(string memory json, string memory key) internal pure returns (address) {
        // vm.parseJsonAddress reverts if key doesn't exist, so we use keyExists
        bytes memory raw = vm.parseJson(json, string.concat(".", key));
        if (raw.length == 0) return address(0);
        address addr = abi.decode(raw, (address));
        return addr;
    }

    /// @notice Validate all deployed templates have correct on-chain state.
    function _validate(address moonwell, address aerodrome, address venice, address wsteth) internal view {
        // Each template should have code deployed
        require(moonwell.code.length > 0, "MoonwellSupplyStrategy: no code");
        console.log("  MoonwellSupplyStrategy:  code OK (%s bytes)", moonwell.code.length);

        require(aerodrome.code.length > 0, "AerodromeLPStrategy: no code");
        console.log("  AerodromeLPStrategy:     code OK (%s bytes)", aerodrome.code.length);

        require(venice.code.length > 0, "VeniceInferenceStrategy: no code");
        console.log("  VeniceInferenceStrategy: code OK (%s bytes)", venice.code.length);

        require(wsteth.code.length > 0, "WstETHMoonwellStrategy: no code");
        console.log("  WstETHMoonwellStrategy:  code OK (%s bytes)", wsteth.code.length);

        // Verify each returns the correct strategy name
        string memory moonwellName = IStrategy(moonwell).name();
        require(keccak256(bytes(moonwellName)) == keccak256("Moonwell Supply"), "MoonwellSupplyStrategy: wrong name");
        console.log("  MoonwellSupplyStrategy:  name OK (\"%s\")", moonwellName);

        string memory aerodromeName = IStrategy(aerodrome).name();
        require(keccak256(bytes(aerodromeName)) == keccak256("Aerodrome LP"), "AerodromeLPStrategy: wrong name");
        console.log("  AerodromeLPStrategy:     name OK (\"%s\")", aerodromeName);

        string memory veniceName = IStrategy(venice).name();
        require(keccak256(bytes(veniceName)) == keccak256("Venice Inference"), "VeniceInferenceStrategy: wrong name");
        console.log("  VeniceInferenceStrategy: name OK (\"%s\")", veniceName);

        string memory wstethName = IStrategy(wsteth).name();
        require(
            keccak256(bytes(wstethName)) == keccak256("wstETH Moonwell Yield"), "WstETHMoonwellStrategy: wrong name"
        );
        console.log("  WstETHMoonwellStrategy:  name OK (\"%s\")", wstethName);

        // Templates should NOT be initialized (vault == address(0))
        require(IStrategy(moonwell).vault() == address(0), "MoonwellSupplyStrategy: already initialized");
        require(IStrategy(aerodrome).vault() == address(0), "AerodromeLPStrategy: already initialized");
        require(IStrategy(venice).vault() == address(0), "VeniceInferenceStrategy: already initialized");
        require(IStrategy(wsteth).vault() == address(0), "WstETHMoonwellStrategy: already initialized");
        console.log("  All templates: vault == address(0) (not initialized) OK");
    }
}
