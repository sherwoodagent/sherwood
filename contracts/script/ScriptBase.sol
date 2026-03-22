// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";

/// @notice Shared helpers for deploy and admin scripts.
///         - Assertion helpers (_checkAddr, _checkUint)
///         - JSON address persistence (_writeAddresses, _readAddress)
///
///         Chain addresses live in contracts/chains/{chainId}.json with
///         CAPS_SNAKE_CASE keys matching contract names.
abstract contract ScriptBase is Script {
    // ── Assertions ──

    function _checkAddr(string memory label, address actual, address expected) internal pure {
        require(actual == expected, string.concat(label, " mismatch"));
    }

    function _checkUint(string memory label, uint256 actual, uint256 expected) internal pure {
        require(actual == expected, string.concat(label, " mismatch"));
    }

    // ── JSON address persistence ──

    /// @notice Write deployed addresses to chains/{chainId}.json
    function _writeAddresses(
        string memory name,
        address deployer,
        address factory,
        address governor,
        address executorLib,
        address vaultImpl
    ) internal {
        string memory obj = "deploy";
        vm.serializeAddress(obj, "BATCH_EXECUTOR_LIB", executorLib);
        vm.serializeAddress(obj, "DEPLOYER", deployer);
        vm.serializeAddress(obj, "SYNDICATE_FACTORY", factory);
        vm.serializeAddress(obj, "SYNDICATE_GOVERNOR", governor);
        vm.serializeAddress(obj, "SYNDICATE_VAULT_IMPL", vaultImpl);
        vm.serializeUint(obj, "chainId", block.chainid);
        string memory json = vm.serializeString(obj, "name", name);

        string memory path = string.concat("chains/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("Addresses written to %s", path);
    }

    /// @notice Read a deployed address from chains/{chainId}.json
    function _readAddress(string memory key) internal view returns (address) {
        string memory path = string.concat("chains/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        return vm.parseJsonAddress(json, string.concat(".", key));
    }
}
