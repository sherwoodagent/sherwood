// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockWoodToken} from "../src/MockWoodToken.sol";
import {VotingEscrow} from "../src/VotingEscrow.sol";
import {Voter} from "../src/Voter.sol";

/// @title VoterSimpleTest — Simplified tests for Voter contract
contract VoterSimpleTest is Test {
    MockWoodToken public wood;
    VotingEscrow public votingEscrow;
    Voter public voter;

    address public owner = address(0x1);
    address public user1 = address(0x2);
    address public mockSyndicateFactory = address(0x5);

    uint256 public tokenId1;

    function setUp() public {
        vm.startPrank(owner);

        wood = new MockWoodToken(owner);
        votingEscrow = new VotingEscrow(address(wood), owner);
        voter = new Voter(address(votingEscrow), mockSyndicateFactory, block.timestamp, owner);

        wood.ownerMint(user1, 10000e18);

        voter.startVoting();
        voter.createGauge(1, address(0x100), 1);
        voter.setGaugeActive(1, true);

        vm.stopPrank();

        vm.prank(user1);
        wood.approve(address(votingEscrow), type(uint256).max);
        vm.prank(user1);
        tokenId1 = votingEscrow.createLock(1000e18, block.timestamp + 365 days, false);
    }

    function testBasicVoting() public {
        assertTrue(voter.isVotingActive());

        vm.prank(user1);
        uint256[] memory syndicateIds = new uint256[](1);
        syndicateIds[0] = 1;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10000;

        voter.vote(tokenId1, syndicateIds, weights);

        uint256 votes = voter.getSyndicateVotes(1, 1);
        assertGt(votes, 0);
    }

    function testEpochFlipping() public {
        assertEq(voter.currentEpoch(), 1);

        uint256 epochEnd = voter.getEpochEnd(1);
        vm.warp(epochEnd + 1);
        voter.flipEpoch();

        assertEq(voter.currentEpoch(), 2);
    }

    function testConstants() public {
        assertEq(voter.EPOCH_DURATION(), 7 days);
        assertEq(voter.QUORUM_THRESHOLD(), 1000); // 10%
        assertEq(voter.MAX_SYNDICATE_SHARE(), 2500); // 25%
    }

    function testGaugeManagement() public {
        vm.prank(owner);
        voter.createGauge(2, address(0x200), 2);

        vm.prank(owner);
        voter.setGaugeActive(2, true);

        uint256[] memory activeSyndicates = voter.getActiveSyndicates();
        assertEq(activeSyndicates.length, 2);
    }

    function testInvalidVote() public {
        vm.prank(user1);
        uint256[] memory syndicateIds = new uint256[](1);
        syndicateIds[0] = 999; // Non-existent
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10000;

        vm.expectRevert();
        voter.vote(tokenId1, syndicateIds, weights);
    }

    function testResetVotes() public {
        // Vote first
        vm.prank(user1);
        uint256[] memory syndicateIds = new uint256[](1);
        syndicateIds[0] = 1;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10000;
        voter.vote(tokenId1, syndicateIds, weights);

        assertGt(voter.getSyndicateVotes(1, 1), 0);

        // Reset
        vm.prank(user1);
        voter.reset(tokenId1);

        assertEq(voter.getSyndicateVotes(1, 1), 0);
    }
}