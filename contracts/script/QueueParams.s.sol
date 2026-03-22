// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {SyndicateGovernor} from "../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../src/interfaces/ISyndicateGovernor.sol";
import {ScriptBase} from "./ScriptBase.sol";

/**
 * @notice Queue governor parameter changes: votingPeriod and cooldownPeriod → 1 hour.
 *         Must be called by the governor owner. After the parameterChangeDelay (1 day)
 *         elapses, run FinalizeParams.s.sol to apply the changes.
 *
 *         Governor address is read from chains/{chainId}.json.
 *
 *   Usage:
 *     forge script script/QueueParams.s.sol:QueueParams \
 *       --rpc-url base \
 *       --account sherwood-agent \
 *       --broadcast
 */
contract QueueParams is ScriptBase {
    function run() external {
        address governorAddr = _readAddress("SYNDICATE_GOVERNOR");
        SyndicateGovernor governor = SyndicateGovernor(governorAddr);

        console.log("Governor:", governorAddr);

        vm.startBroadcast();

        governor.setVotingPeriod(1 hours);
        console.log("Queued votingPeriod = 1 hour");

        governor.setCooldownPeriod(1 hours);
        console.log("Queued cooldownPeriod = 1 hour");

        vm.stopBroadcast();

        // ── Validate the changes were queued ──
        bytes32 PARAM_VOTING_PERIOD = keccak256("votingPeriod");
        bytes32 PARAM_COOLDOWN = keccak256("cooldownPeriod");

        ISyndicateGovernor.PendingChange memory vpChange = governor.getPendingChange(PARAM_VOTING_PERIOD);
        ISyndicateGovernor.PendingChange memory cdChange = governor.getPendingChange(PARAM_COOLDOWN);

        require(vpChange.exists, "votingPeriod change not queued");
        require(vpChange.newValue == 1 hours, "votingPeriod pending value mismatch");
        console.log("Verified: votingPeriod queued, effectiveAt=%s", vpChange.effectiveAt);

        require(cdChange.exists, "cooldownPeriod change not queued");
        require(cdChange.newValue == 1 hours, "cooldownPeriod pending value mismatch");
        console.log("Verified: cooldownPeriod queued, effectiveAt=%s", cdChange.effectiveAt);

        console.log("\nRun FinalizeParams.s.sol after the delay elapses.");
    }
}
