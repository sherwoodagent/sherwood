// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ScriptBase} from "./ScriptBase.sol";
import {console} from "forge-std/console.sol";
import {IStrategy} from "../src/interfaces/IStrategy.sol";
import {MoonwellSupplyStrategy} from "../src/strategies/MoonwellSupplyStrategy.sol";
import {AerodromeLPStrategy} from "../src/strategies/AerodromeLPStrategy.sol";
import {VeniceInferenceStrategy} from "../src/strategies/VeniceInferenceStrategy.sol";
import {WstETHMoonwellStrategy} from "../src/strategies/WstETHMoonwellStrategy.sol";
import {MamoYieldStrategy} from "../src/strategies/MamoYieldStrategy.sol";
import {HyperliquidPerpStrategy} from "../src/strategies/HyperliquidPerpStrategy.sol";

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
    string constant MAMO_KEY = "MAMO_YIELD_TEMPLATE";
    string constant HYPERLIQUID_KEY = "HYPERLIQUID_PERP_TEMPLATE";

    struct Templates {
        address moonwell;
        address aerodrome;
        address venice;
        address wsteth;
        address mamo;
        address hyperliquid;
    }

    function run() external {
        string memory path = string.concat(vm.projectRoot(), "/chains/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);

        // ── 1. Check which templates are already deployed ──

        Templates memory t;
        t.moonwell = _tryReadAddress(json, MOONWELL_KEY);
        t.aerodrome = _tryReadAddress(json, AERODROME_KEY);
        t.venice = _tryReadAddress(json, VENICE_KEY);
        t.wsteth = _tryReadAddress(json, WSTETH_KEY);
        t.mamo = _tryReadAddress(json, MAMO_KEY);
        t.hyperliquid = _tryReadAddress(json, HYPERLIQUID_KEY);

        bool anyDeployed = false;

        console.log("\n=== Strategy Template Deployment ===\n");

        // ── 2. Deploy missing templates ──

        vm.startBroadcast();

        if (_needsDeploy(t.moonwell)) {
            if (t.moonwell != address(0)) {
                console.log("  Stale    MoonwellSupplyStrategy:   %s (no code, redeploying)", t.moonwell);
            }
            t.moonwell = address(new MoonwellSupplyStrategy());
            console.log("  Deployed MoonwellSupplyStrategy:   %s", t.moonwell);
            anyDeployed = true;
        } else {
            console.log("  Skipped  MoonwellSupplyStrategy:   %s (already deployed)", t.moonwell);
        }

        if (_needsDeploy(t.aerodrome)) {
            if (t.aerodrome != address(0)) {
                console.log("  Stale    AerodromeLPStrategy:      %s (no code, redeploying)", t.aerodrome);
            }
            t.aerodrome = address(new AerodromeLPStrategy());
            console.log("  Deployed AerodromeLPStrategy:      %s", t.aerodrome);
            anyDeployed = true;
        } else {
            console.log("  Skipped  AerodromeLPStrategy:      %s (already deployed)", t.aerodrome);
        }

        if (_needsDeploy(t.venice)) {
            if (t.venice != address(0)) {
                console.log("  Stale    VeniceInferenceStrategy:  %s (no code, redeploying)", t.venice);
            }
            t.venice = address(new VeniceInferenceStrategy());
            console.log("  Deployed VeniceInferenceStrategy:  %s", t.venice);
            anyDeployed = true;
        } else {
            console.log("  Skipped  VeniceInferenceStrategy:  %s (already deployed)", t.venice);
        }

        if (_needsDeploy(t.wsteth)) {
            if (t.wsteth != address(0)) {
                console.log("  Stale    WstETHMoonwellStrategy:   %s (no code, redeploying)", t.wsteth);
            }
            t.wsteth = address(new WstETHMoonwellStrategy());
            console.log("  Deployed WstETHMoonwellStrategy:   %s", t.wsteth);
            anyDeployed = true;
        } else {
            console.log("  Skipped  WstETHMoonwellStrategy:   %s (already deployed)", t.wsteth);
        }

        if (_needsDeploy(t.mamo)) {
            if (t.mamo != address(0)) {
                console.log("  Stale    MamoYieldStrategy:        %s (no code, redeploying)", t.mamo);
            }
            t.mamo = address(new MamoYieldStrategy());
            console.log("  Deployed MamoYieldStrategy:        %s", t.mamo);
            anyDeployed = true;
        } else {
            console.log("  Skipped  MamoYieldStrategy:        %s (already deployed)", t.mamo);
        }

        // A1: HyperliquidPerpStrategy only deploys on HyperEVM (chain ID 999)
        if (block.chainid == 999) {
            if (_needsDeploy(t.hyperliquid)) {
                if (t.hyperliquid != address(0)) {
                    console.log("  Stale    HyperliquidPerpStrategy:  %s (no code, redeploying)", t.hyperliquid);
                }
                t.hyperliquid = address(new HyperliquidPerpStrategy());
                console.log("  Deployed HyperliquidPerpStrategy:  %s", t.hyperliquid);
                anyDeployed = true;
            } else {
                console.log("  Skipped  HyperliquidPerpStrategy:  %s (already deployed)", t.hyperliquid);
            }
        } else {
            console.log("  Skipped  HyperliquidPerpStrategy:  N/A (not on HyperEVM, chainId=%s)", block.chainid);
        }

        vm.stopBroadcast();

        // ── 3. Save addresses ──

        if (anyDeployed) {
            vm.writeJson(vm.toString(t.moonwell), path, string.concat(".", MOONWELL_KEY));
            vm.writeJson(vm.toString(t.aerodrome), path, string.concat(".", AERODROME_KEY));
            vm.writeJson(vm.toString(t.venice), path, string.concat(".", VENICE_KEY));
            vm.writeJson(vm.toString(t.wsteth), path, string.concat(".", WSTETH_KEY));
            vm.writeJson(vm.toString(t.mamo), path, string.concat(".", MAMO_KEY));
            if (block.chainid == 999) {
                vm.writeJson(vm.toString(t.hyperliquid), path, string.concat(".", HYPERLIQUID_KEY));
            }
            console.log("\n  Addresses saved to %s", path);
        } else {
            console.log("\n  All templates already deployed, nothing to save.");
        }

        // ── 4. Validate ──

        console.log("\n=== Validation ===\n");
        _validate(t);
        console.log("\n  All validations passed.\n");
    }

    // ── Helpers ──

    function _needsDeploy(address addr) internal view returns (bool) {
        return addr == address(0) || addr.code.length == 0;
    }

    /// @notice Try to read an address from JSON; return address(0) if key missing or zero.
    function _tryReadAddress(string memory json, string memory key) internal pure returns (address) {
        bytes memory raw = vm.parseJson(json, string.concat(".", key));
        if (raw.length == 0) return address(0);
        address addr = abi.decode(raw, (address));
        return addr;
    }

    /// @notice Validate all deployed templates have correct on-chain state.
    function _validate(Templates memory t) internal view {
        // Each template should have code deployed
        require(t.moonwell.code.length > 0, "MoonwellSupplyStrategy: no code");
        console.log("  MoonwellSupplyStrategy:  code OK (%s bytes)", t.moonwell.code.length);

        require(t.aerodrome.code.length > 0, "AerodromeLPStrategy: no code");
        console.log("  AerodromeLPStrategy:     code OK (%s bytes)", t.aerodrome.code.length);

        require(t.venice.code.length > 0, "VeniceInferenceStrategy: no code");
        console.log("  VeniceInferenceStrategy: code OK (%s bytes)", t.venice.code.length);

        require(t.wsteth.code.length > 0, "WstETHMoonwellStrategy: no code");
        console.log("  WstETHMoonwellStrategy:  code OK (%s bytes)", t.wsteth.code.length);

        require(t.mamo.code.length > 0, "MamoYieldStrategy: no code");
        console.log("  MamoYieldStrategy:       code OK (%s bytes)", t.mamo.code.length);

        // A1: Only validate Hyperliquid on HyperEVM (chain ID 999)
        if (block.chainid == 999) {
            require(t.hyperliquid.code.length > 0, "HyperliquidPerpStrategy: no code");
            console.log("  HyperliquidPerpStrategy: code OK (%s bytes)", t.hyperliquid.code.length);
        } else {
            console.log("  HyperliquidPerpStrategy: skipped (not on HyperEVM)");
        }

        // Verify each returns the correct strategy name
        _validateName(t.moonwell, "Moonwell Supply", "MoonwellSupplyStrategy");
        _validateName(t.aerodrome, "Aerodrome LP", "AerodromeLPStrategy");
        _validateName(t.venice, "Venice Inference", "VeniceInferenceStrategy");
        _validateName(t.wsteth, "wstETH Moonwell Yield", "WstETHMoonwellStrategy");
        _validateName(t.mamo, "Mamo Yield", "MamoYieldStrategy");
        if (block.chainid == 999) {
            _validateName(t.hyperliquid, "Hyperliquid Perp", "HyperliquidPerpStrategy");
        }

        // Templates should NOT be initialized (vault == address(0))
        require(IStrategy(t.moonwell).vault() == address(0), "MoonwellSupplyStrategy: already initialized");
        require(IStrategy(t.aerodrome).vault() == address(0), "AerodromeLPStrategy: already initialized");
        require(IStrategy(t.venice).vault() == address(0), "VeniceInferenceStrategy: already initialized");
        require(IStrategy(t.wsteth).vault() == address(0), "WstETHMoonwellStrategy: already initialized");
        require(IStrategy(t.mamo).vault() == address(0), "MamoYieldStrategy: already initialized");
        if (block.chainid == 999) {
            require(IStrategy(t.hyperliquid).vault() == address(0), "HyperliquidPerpStrategy: already initialized");
        }
        console.log("  All templates: vault == address(0) (not initialized) OK");
    }

    function _validateName(address template, string memory expected, string memory label) internal view {
        string memory actual = IStrategy(template).name();
        require(keccak256(bytes(actual)) == keccak256(bytes(expected)), string.concat(label, ": wrong name"));
        console.log("  %s: name OK (\"%s\")", label, actual);
    }
}
