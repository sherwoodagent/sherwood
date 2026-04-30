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
import {HyperliquidGridStrategy} from "../src/strategies/HyperliquidGridStrategy.sol";

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

        bool isHyperEvm = block.chainid == 999;
        bool anyDeployed = false;

        console.log("\n=== Strategy Template Deployment ===\n");

        // ── 2. Deploy missing templates ──

        vm.startBroadcast();

        // Moonwell/Aerodrome/Venice/wstETH-Moonwell/Mamo are not active on HyperEVM
        // (no Moonwell, Uniswap, Venice, or Aerodrome on chain 999). Only HyperliquidPerp
        // deploys there. Off HyperEVM, only the five non-perp templates deploy.
        if (isHyperEvm) {
            console.log("  Skipped  MoonwellSupplyStrategy:   N/A on HyperEVM");
            console.log("  Skipped  AerodromeLPStrategy:      N/A on HyperEVM");
            console.log("  Skipped  VeniceInferenceStrategy:  N/A on HyperEVM");
            console.log("  Skipped  WstETHMoonwellStrategy:   N/A on HyperEVM");
            console.log("  Skipped  MamoYieldStrategy:        N/A on HyperEVM");
        } else {
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
        }

        if (isHyperEvm) {
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
            if (isHyperEvm) {
                vm.writeJson(vm.toString(t.hyperliquid), path, string.concat(".", HYPERLIQUID_KEY));
            } else {
                vm.writeJson(vm.toString(t.moonwell), path, string.concat(".", MOONWELL_KEY));
                vm.writeJson(vm.toString(t.aerodrome), path, string.concat(".", AERODROME_KEY));
                vm.writeJson(vm.toString(t.venice), path, string.concat(".", VENICE_KEY));
                vm.writeJson(vm.toString(t.wsteth), path, string.concat(".", WSTETH_KEY));
                vm.writeJson(vm.toString(t.mamo), path, string.concat(".", MAMO_KEY));
            }
            console.log("\n  Addresses saved to %s", path);
        } else {
            console.log("\n  All templates already deployed, nothing to save.");
        }

        // ── 4. Validate ──

        console.log("\n=== Validation ===\n");
        _validate(t, isHyperEvm);
        console.log("\n  All validations passed.\n");
    }

    /// @notice Test helper — deploys a fresh `HyperliquidGridStrategy` template.
    ///         Used by `HyperEVMIntegrationTest.setUp()`. Does not persist to JSON.
    /// @dev Caller is responsible for `vm.startBroadcast()` if needed.
    function _deployHyperliquidGridTemplate() public returns (address) {
        return address(new HyperliquidGridStrategy());
    }

    /// @notice Test helper — deploys a fresh `HyperliquidPerpStrategy` template.
    function _deployHyperliquidPerpTemplate() public returns (address) {
        return address(new HyperliquidPerpStrategy());
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
    function _validate(Templates memory t, bool isHyperEvm) internal view {
        // Each template should have code deployed (skip the five disabled-on-HyperEVM)
        if (isHyperEvm) {
            console.log("  MoonwellSupplyStrategy:  skipped (not on HyperEVM)");
            console.log("  AerodromeLPStrategy:     skipped (not on HyperEVM)");
            console.log("  VeniceInferenceStrategy: skipped (not on HyperEVM)");
            console.log("  WstETHMoonwellStrategy:  skipped (not on HyperEVM)");
            console.log("  MamoYieldStrategy:       skipped (not on HyperEVM)");

            require(t.hyperliquid.code.length > 0, "HyperliquidPerpStrategy: no code");
            console.log("  HyperliquidPerpStrategy: code OK (%s bytes)", t.hyperliquid.code.length);

            _validateName(t.hyperliquid, "Hyperliquid Perp", "HyperliquidPerpStrategy");

            require(IStrategy(t.hyperliquid).vault() == address(0), "HyperliquidPerpStrategy: already initialized");
        } else {
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

            console.log("  HyperliquidPerpStrategy: skipped (not on HyperEVM)");

            _validateName(t.moonwell, "Moonwell Supply", "MoonwellSupplyStrategy");
            _validateName(t.aerodrome, "Aerodrome LP", "AerodromeLPStrategy");
            _validateName(t.venice, "Venice Inference", "VeniceInferenceStrategy");
            _validateName(t.wsteth, "wstETH Moonwell Yield", "WstETHMoonwellStrategy");
            _validateName(t.mamo, "Mamo Yield", "MamoYieldStrategy");

            require(IStrategy(t.moonwell).vault() == address(0), "MoonwellSupplyStrategy: already initialized");
            require(IStrategy(t.aerodrome).vault() == address(0), "AerodromeLPStrategy: already initialized");
            require(IStrategy(t.venice).vault() == address(0), "VeniceInferenceStrategy: already initialized");
            require(IStrategy(t.wsteth).vault() == address(0), "WstETHMoonwellStrategy: already initialized");
            require(IStrategy(t.mamo).vault() == address(0), "MamoYieldStrategy: already initialized");
        }
        console.log("  All templates: vault == address(0) (not initialized) OK");
    }

    function _validateName(address template, string memory expected, string memory label) internal view {
        string memory actual = IStrategy(template).name();
        require(keccak256(bytes(actual)) == keccak256(bytes(expected)), string.concat(label, ": wrong name"));
        console.log("  %s: name OK (\"%s\")", label, actual);
    }
}
