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

        string memory path = string.concat(vm.projectRoot(), "/chains/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("Addresses written to %s", path);
    }

    /// @notice Patch a single address into chains/{chainId}.json at a top-level
    ///         key, preserving any existing keys (uses `vm.writeJson` path mode).
    ///         Used by deploy scripts that add to an existing JSON rather than
    ///         replacing it wholesale.
    function _patchAddress(string memory key, address value) internal {
        string memory path = string.concat(vm.projectRoot(), "/chains/", vm.toString(block.chainid), ".json");
        vm.writeJson(vm.serializeAddress("", "", value), path, string.concat(".", key));
    }

    /// @notice Read a deployed address from chains/{chainId}.json
    function _readAddress(string memory key) internal view returns (address) {
        string memory path = string.concat(vm.projectRoot(), "/chains/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        return vm.parseJsonAddress(json, string.concat(".", key));
    }

    /// @notice Write tokenomics addresses to chains/{chainId}.json (appends to existing)
    function _writeTokenomicsAddresses(
        address woodToken,
        address votingEscrow,
        address voter,
        address minter,
        address rewardsDistributor,
        address voteIncentive
    ) internal {
        string memory path = string.concat(vm.projectRoot(), "/chains/", vm.toString(block.chainid), ".json");

        vm.writeJson(vm.serializeAddress("", "", woodToken), path, ".WOOD_TOKEN");
        vm.writeJson(vm.serializeAddress("", "", votingEscrow), path, ".VOTING_ESCROW");
        vm.writeJson(vm.serializeAddress("", "", voter), path, ".VOTER");
        vm.writeJson(vm.serializeAddress("", "", minter), path, ".MINTER");
        vm.writeJson(vm.serializeAddress("", "", rewardsDistributor), path, ".REWARDS_DISTRIBUTOR");
        vm.writeJson(vm.serializeAddress("", "", voteIncentive), path, ".VOTE_INCENTIVE");

        console.log("Tokenomics addresses written to %s", path);
    }
}
