// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {SyndicateGovernor} from "../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../src/interfaces/ISyndicateGovernor.sol";
import {ScriptBase} from "./ScriptBase.sol";

/**
 * @notice Set the factory address on the governor and register existing vaults.
 *         Must be called by the governor owner.
 *
 *   Usage:
 *     forge script script/RegisterVaults.s.sol:RegisterVaults \
 *       --rpc-url base \
 *       --account sherwood-agent \
 *       --broadcast
 */
contract RegisterVaults is ScriptBase {
    function run() external {
        address governorAddr = _readAddress("SYNDICATE_GOVERNOR");
        address factoryAddr = _readAddress("SYNDICATE_FACTORY");
        SyndicateGovernor governor = SyndicateGovernor(governorAddr);

        console.log("Governor:", governorAddr);
        console.log("Factory:", factoryAddr);

        // Existing vaults that need registration
        address[3] memory vaults = [
            0xa4aF960CAFDe8BF5dc93Fc3b62175968C107892f,
            0x1475fFC5d81D558e169441b6587874b4f773f992,
            0x38c499361048513E0cce30dbAe16622aA1CE0229
        ];

        vm.startBroadcast();

        // V1.5: timelock removed. setFactory applies immediately.
        if (governor.factory() != factoryAddr) {
            governor.setFactory(factoryAddr);
            console.log("setFactory applied");
        } else {
            console.log("factory already wired");
        }

        // 2. Register existing vaults
        for (uint256 i = 0; i < vaults.length; i++) {
            governor.addVault(vaults[i]);
            console.log("addVault:", vaults[i]);
        }

        vm.stopBroadcast();

        // ── Validate ──
        require(governor.factory() == factoryAddr, "factory not set");
        console.log("\nVerified: factory = %s", governor.factory());

        for (uint256 i = 0; i < vaults.length; i++) {
            require(governor.isRegisteredVault(vaults[i]), "vault not registered");
            console.log("Verified: vault registered %s", vaults[i]);
        }
    }
}
