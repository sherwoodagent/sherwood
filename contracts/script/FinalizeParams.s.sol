// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {SyndicateGovernor} from "../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../src/interfaces/ISyndicateGovernor.sol";
import {ScriptBase} from "./ScriptBase.sol";

/**
 * @notice Finalize queued governor parameter changes (votingPeriod + cooldownPeriod).
 *         Must be called by the governor owner after the parameterChangeDelay has elapsed.
 *
 *         Governor address is read from chains/{chainId}.json.
 *
 *   Usage:
 *     forge script script/FinalizeParams.s.sol:FinalizeParams \
 *       --rpc-url base \
 *       --account sherwood-agent \
 *       --broadcast
 */
contract FinalizeParams is ScriptBase {
    function run() external {
        address governorAddr = _readAddress("SYNDICATE_GOVERNOR");
        SyndicateGovernor governor = SyndicateGovernor(governorAddr);

        bytes32 PARAM_VOTING_PERIOD = keccak256("votingPeriod");
        bytes32 PARAM_COOLDOWN = keccak256("cooldownPeriod");

        console.log("Governor:", governorAddr);

        vm.startBroadcast();

        governor.finalizeParameterChange(PARAM_VOTING_PERIOD);
        console.log("Finalized votingPeriod");

        governor.finalizeParameterChange(PARAM_COOLDOWN);
        console.log("Finalized cooldownPeriod");

        vm.stopBroadcast();

        // ── Validate the params are now active ──
        ISyndicateGovernor.GovernorParams memory p = governor.getGovernorParams();

        require(p.votingPeriod == 1 hours, "votingPeriod not 1 hour");
        console.log("Verified: votingPeriod = %s", p.votingPeriod);

        require(p.cooldownPeriod == 1 hours, "cooldownPeriod not 1 hour");
        console.log("Verified: cooldownPeriod = %s", p.cooldownPeriod);

        // Confirm no pending changes remain
        ISyndicateGovernor.PendingChange memory vpChange = governor.getPendingChange(PARAM_VOTING_PERIOD);
        ISyndicateGovernor.PendingChange memory cdChange = governor.getPendingChange(PARAM_COOLDOWN);
        require(!vpChange.exists, "votingPeriod still has pending change");
        require(!cdChange.exists, "cooldownPeriod still has pending change");

        console.log("Verified: no pending changes remain");
    }
}
