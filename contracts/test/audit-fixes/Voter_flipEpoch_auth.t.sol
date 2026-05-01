// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WoodToken} from "../../src/WoodToken.sol";
import {VotingEscrow} from "../../src/VotingEscrow.sol";
import {Voter} from "../../src/Voter.sol";
import {MockLzEndpoint} from "../mocks/MockLzEndpoint.sol";

/// @title Voter_flipEpoch_auth — MS-C1 regression
/// @notice Confirms `Voter.flipEpoch()` rejects unauthorized callers and
///         accepts only the configured `minter` and `owner`.
contract VoterFlipEpochAuthTest is Test {
    WoodToken public wood;
    VotingEscrow public votingEscrow;
    Voter public voter;

    address public owner = address(0x1);
    address public minter = address(0xBEEF);
    address public attacker = address(0xBAD);
    address public mockSyndicateFactory = address(0x5);

    function setUp() public {
        vm.startPrank(owner);
        MockLzEndpoint lzEndpoint = new MockLzEndpoint();
        wood = new WoodToken(address(lzEndpoint), owner, owner);
        votingEscrow = new VotingEscrow(address(wood), owner);
        voter = new Voter(address(votingEscrow), mockSyndicateFactory, block.timestamp, address(wood), minter, owner);
        vm.stopPrank();
    }

    /// @notice MS-C1: a random EOA cannot advance the epoch counter.
    function test_flipEpoch_revertsForRandomEoa() public {
        // Warp past the current epoch end so the time-gate is satisfied.
        vm.warp(voter.getEpochEnd(voter.currentEpoch()) + 1);

        vm.prank(attacker);
        vm.expectRevert(Voter.NotAuthorized.selector);
        voter.flipEpoch();

        // Counter must remain at the initial epoch.
        assertEq(voter.currentEpoch(), 1);
    }

    /// @notice The configured minter remains a valid caller.
    function test_flipEpoch_succeedsForMinter() public {
        vm.warp(voter.getEpochEnd(voter.currentEpoch()) + 1);

        vm.prank(minter);
        voter.flipEpoch();

        assertEq(voter.currentEpoch(), 2);
    }

    /// @notice The owner remains a valid caller (rescue path).
    function test_flipEpoch_succeedsForOwner() public {
        vm.warp(voter.getEpochEnd(voter.currentEpoch()) + 1);

        vm.prank(owner);
        voter.flipEpoch();

        assertEq(voter.currentEpoch(), 2);
    }
}
