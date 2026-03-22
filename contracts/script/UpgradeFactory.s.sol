// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {SyndicateFactory} from "../src/SyndicateFactory.sol";
import {ISyndicateGovernor} from "../src/interfaces/ISyndicateGovernor.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ScriptBase} from "./ScriptBase.sol";

/**
 * @notice Upgrade SyndicateFactory to V2 (adds governor.addVault in createSyndicate).
 *
 *   Steps:
 *     1. Snapshot current on-chain state (owner, governor, vaultImpl, etc.)
 *     2. Deploy new SyndicateFactory implementation
 *     3. Call upgradeToAndCall on the proxy
 *     4. Validate all state survived the upgrade
 *
 *   Must be called by the factory owner.
 *
 *   Usage:
 *     forge script script/UpgradeFactory.s.sol:UpgradeFactory \
 *       --rpc-url base \
 *       --account sherwood-agent \
 *       --broadcast
 */
contract UpgradeFactory is ScriptBase {
    // Pre-upgrade snapshot
    struct Snapshot {
        address owner;
        address executorImpl;
        address vaultImpl;
        address ensRegistrar;
        address agentRegistry;
        address governor;
        uint256 managementFeeBps;
        uint256 syndicateCount;
        bool upgradesEnabled;
        address creationFeeRecipient;
        uint256 creationFee;
    }

    function run() external {
        address factoryAddr = _readAddress("SYNDICATE_FACTORY");
        SyndicateFactory factory = SyndicateFactory(factoryAddr);

        console.log("Factory proxy:", factoryAddr);
        console.log("Owner:", factory.owner());

        // ── 1. Snapshot pre-upgrade state ──
        Snapshot memory snap = _snapshot(factory);
        console.log("\n--- Pre-upgrade snapshot ---");
        _logSnapshot(snap);

        // Also snapshot first syndicate vault if any exist
        address firstVault;
        if (snap.syndicateCount > 0) {
            (,address v,,,,,) = factory.syndicates(1);
            firstVault = v;
            console.log("Syndicate #1 vault:", firstVault);
        }

        vm.startBroadcast();

        // ── 2. Deploy new implementation ──
        SyndicateFactory newImpl = new SyndicateFactory();
        console.log("\nNew implementation:", address(newImpl));

        // ── 3. Upgrade proxy ──
        factory.upgradeToAndCall(address(newImpl), "");
        console.log("Upgrade complete");

        vm.stopBroadcast();

        // ── 4. Validate post-upgrade state ──
        console.log("\n--- Post-upgrade validation ---");
        _validate(factory, snap, firstVault);

        // ── 5. Write new impl address ──
        string memory path = string.concat(vm.projectRoot(), "/chains/", vm.toString(block.chainid), ".json");
        vm.writeJson(vm.toString(address(newImpl)), path, ".SYNDICATE_FACTORY_V2");
        console.log("\nSaved SYNDICATE_FACTORY_V2 to chains/%s.json", vm.toString(block.chainid));
    }

    function _snapshot(SyndicateFactory factory) internal view returns (Snapshot memory s) {
        s.owner = factory.owner();
        s.executorImpl = factory.executorImpl();
        s.vaultImpl = factory.vaultImpl();
        s.ensRegistrar = address(factory.ensRegistrar());
        s.agentRegistry = address(factory.agentRegistry());
        s.governor = factory.governor();
        s.managementFeeBps = factory.managementFeeBps();
        s.syndicateCount = factory.syndicateCount();
        s.upgradesEnabled = factory.upgradesEnabled();
        s.creationFeeRecipient = factory.creationFeeRecipient();
        s.creationFee = factory.creationFee();
    }

    function _logSnapshot(Snapshot memory s) internal pure {
        console.log("  owner:", s.owner);
        console.log("  executorImpl:", s.executorImpl);
        console.log("  vaultImpl:", s.vaultImpl);
        console.log("  ensRegistrar:", s.ensRegistrar);
        console.log("  agentRegistry:", s.agentRegistry);
        console.log("  governor:", s.governor);
        console.log("  managementFeeBps:", s.managementFeeBps);
        console.log("  syndicateCount:", s.syndicateCount);
        console.log("  upgradesEnabled:", s.upgradesEnabled);
        console.log("  creationFee:", s.creationFee);
        console.log("  creationFeeRecipient:", s.creationFeeRecipient);
    }

    function _validate(SyndicateFactory factory, Snapshot memory snap, address firstVault) internal view {
        require(factory.owner() == snap.owner, "owner changed");
        console.log("  owner: OK");

        require(factory.executorImpl() == snap.executorImpl, "executorImpl changed");
        console.log("  executorImpl: OK");

        require(factory.vaultImpl() == snap.vaultImpl, "vaultImpl changed");
        console.log("  vaultImpl: OK");

        require(address(factory.ensRegistrar()) == snap.ensRegistrar, "ensRegistrar changed");
        console.log("  ensRegistrar: OK");

        require(address(factory.agentRegistry()) == snap.agentRegistry, "agentRegistry changed");
        console.log("  agentRegistry: OK");

        require(factory.governor() == snap.governor, "governor changed");
        console.log("  governor: OK");

        require(factory.managementFeeBps() == snap.managementFeeBps, "managementFeeBps changed");
        console.log("  managementFeeBps: OK");

        require(factory.syndicateCount() == snap.syndicateCount, "syndicateCount changed");
        console.log("  syndicateCount: OK (%s)", snap.syndicateCount);

        require(factory.upgradesEnabled() == snap.upgradesEnabled, "upgradesEnabled changed");
        console.log("  upgradesEnabled: OK");

        require(factory.creationFee() == snap.creationFee, "creationFee changed");
        console.log("  creationFee: OK");

        require(factory.creationFeeRecipient() == snap.creationFeeRecipient, "creationFeeRecipient changed");
        console.log("  creationFeeRecipient: OK");

        // Validate syndicate mapping survived
        if (firstVault != address(0)) {
            (,address v,,,,,) = factory.syndicates(1);
            require(v == firstVault, "syndicate #1 vault changed");
            console.log("  syndicate #1 vault: OK (%s)", firstVault);

            uint256 mapped = factory.vaultToSyndicate(firstVault);
            require(mapped == 1, "vaultToSyndicate mapping broken");
            console.log("  vaultToSyndicate: OK");
        }

        console.log("\nAll validations passed.");
    }
}
