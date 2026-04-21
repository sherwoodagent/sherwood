// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "forge-std/Test.sol";

import {SyndicateGovernor} from "../../src/SyndicateGovernor.sol";
import {ISyndicateGovernor} from "../../src/interfaces/ISyndicateGovernor.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MockRegistryMinimal} from "../mocks/MockRegistryMinimal.sol";

/// @title ProtocolFeeRecipientTimelock.t
/// @notice Covers G-C5: setProtocolFeeRecipient now queues through the
///         GovernorParameters timelock. Previously instant, which allowed an
///         owner to defeat the setProtocolFeeBps timelock by pairing a delayed
///         bps bump with an instant recipient swap at finalize time.
contract ProtocolFeeRecipientTimelockTest is Test {
    SyndicateGovernor public governor;
    MockRegistryMinimal public guardianRegistry;

    address public owner = makeAddr("owner");
    address public recipient1 = makeAddr("recipient1");
    address public recipient2 = makeAddr("recipient2");
    address public random = makeAddr("random");

    uint256 constant VOTING_PERIOD = 1 days;
    uint256 constant EXECUTION_WINDOW = 1 days;
    uint256 constant VETO_THRESHOLD_BPS = 4000;
    uint256 constant MAX_PERF_FEE_BPS = 3000;
    uint256 constant COOLDOWN_PERIOD = 1 days;
    uint256 constant PARAM_CHANGE_DELAY = 1 days;

    function setUp() public {
        guardianRegistry = new MockRegistryMinimal();

        SyndicateGovernor govImpl = new SyndicateGovernor();
        bytes memory govInit = abi.encodeCall(
            SyndicateGovernor.initialize,
            (
                ISyndicateGovernor.InitParams({
                    owner: owner,
                    votingPeriod: VOTING_PERIOD,
                    executionWindow: EXECUTION_WINDOW,
                    vetoThresholdBps: VETO_THRESHOLD_BPS,
                    maxPerformanceFeeBps: MAX_PERF_FEE_BPS,
                    cooldownPeriod: COOLDOWN_PERIOD,
                    collaborationWindow: 48 hours,
                    maxCoProposers: 5,
                    minStrategyDuration: 1 hours,
                    maxStrategyDuration: 30 days,
                    parameterChangeDelay: PARAM_CHANGE_DELAY,
                    protocolFeeBps: 200,
                    protocolFeeRecipient: recipient1
                }),
                address(guardianRegistry)
            )
        );
        governor = SyndicateGovernor(address(new ERC1967Proxy(address(govImpl), govInit)));
    }

    // ── Helpers ──

    function _paramKey() internal view returns (bytes32) {
        return governor.PARAM_PROTOCOL_FEE_RECIPIENT();
    }

    // ── Tests ──

    /// @notice setProtocolFeeRecipient must queue a pending change rather than
    ///         applying the new recipient instantly. This is the core G-C5 fix:
    ///         the recipient now shares the same timelock as protocolFeeBps.
    function test_setProtocolFeeRecipient_queues_notInstant() public {
        assertEq(governor.protocolFeeRecipient(), recipient1);

        vm.prank(owner);
        governor.setProtocolFeeRecipient(recipient2);

        // Recipient is unchanged — only queued.
        assertEq(governor.protocolFeeRecipient(), recipient1);

        ISyndicateGovernor.PendingChange memory pending = governor.getPendingChange(_paramKey());
        assertTrue(pending.exists);
        assertEq(pending.newValue, uint256(uint160(recipient2)));
        assertEq(pending.effectiveAt, block.timestamp + PARAM_CHANGE_DELAY);
    }

    /// @notice After the delay elapses, finalize applies the new recipient.
    function test_setProtocolFeeRecipient_finalizesAfterDelay() public {
        vm.startPrank(owner);
        governor.setProtocolFeeRecipient(recipient2);

        vm.warp(block.timestamp + PARAM_CHANGE_DELAY + 1);

        governor.finalizeParameterChange(_paramKey());
        vm.stopPrank();

        assertEq(governor.protocolFeeRecipient(), recipient2);

        // Pending slot cleared.
        ISyndicateGovernor.PendingChange memory pending = governor.getPendingChange(_paramKey());
        assertFalse(pending.exists);
    }

    /// @notice Finalizing before the delay elapses must revert.
    function test_setProtocolFeeRecipient_revertsBeforeDelay() public {
        bytes32 key = _paramKey();
        vm.startPrank(owner);
        governor.setProtocolFeeRecipient(recipient2);

        // One second short of the delay.
        vm.warp(block.timestamp + PARAM_CHANGE_DELAY - 1);

        vm.expectRevert(ISyndicateGovernor.ChangeNotReady.selector);
        governor.finalizeParameterChange(key);
        vm.stopPrank();

        assertEq(governor.protocolFeeRecipient(), recipient1);
    }

    /// @notice Owner can cancel a pending recipient change at any time.
    function test_setProtocolFeeRecipient_cancelable() public {
        vm.startPrank(owner);
        governor.setProtocolFeeRecipient(recipient2);

        governor.cancelParameterChange(_paramKey());
        vm.stopPrank();

        assertEq(governor.protocolFeeRecipient(), recipient1);
        ISyndicateGovernor.PendingChange memory pending = governor.getPendingChange(_paramKey());
        assertFalse(pending.exists);

        // Can now queue a fresh change.
        vm.prank(owner);
        governor.setProtocolFeeRecipient(recipient2);
        pending = governor.getPendingChange(_paramKey());
        assertTrue(pending.exists);
    }

    /// @notice Queueing a zero-address recipient must revert.
    function test_setProtocolFeeRecipient_revertsZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(ISyndicateGovernor.InvalidProtocolFeeRecipient.selector);
        governor.setProtocolFeeRecipient(address(0));
    }

    /// @notice Queueing while a change is already pending must revert.
    function test_setProtocolFeeRecipient_revertsIfAlreadyPending() public {
        vm.startPrank(owner);
        governor.setProtocolFeeRecipient(recipient2);

        vm.expectRevert(ISyndicateGovernor.ChangeAlreadyPending.selector);
        governor.setProtocolFeeRecipient(random);
        vm.stopPrank();
    }

    /// @notice Non-owner cannot queue a recipient change.
    function test_setProtocolFeeRecipient_revertsIfNotOwner() public {
        vm.prank(random);
        vm.expectRevert();
        governor.setProtocolFeeRecipient(recipient2);
    }
}
