// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockWoodToken} from "../src/MockWoodToken.sol";
import {VotingEscrow} from "../src/VotingEscrow.sol";
import {Voter} from "../src/Voter.sol";
import {Minter} from "../src/Minter.sol";

/// @title VeWoodTest — Basic functionality test for ve(3,3) contracts
/// @notice Tests that the core ve(3,3) tokenomics contracts work together correctly
contract VeWoodTest is Test {
    MockWoodToken public wood;
    VotingEscrow public votingEscrow;
    Voter public voter;
    Minter public minter;

    address public owner = address(0x1);
    address public user = address(0x2);
    address public treasury = address(0x3);

    function setUp() public {
        vm.startPrank(owner);

        // Deploy token and escrow first
        wood = new MockWoodToken(owner);
        votingEscrow = new VotingEscrow(address(wood), owner);

        // Create a mock syndicate factory address
        address mockSyndicateFactory = address(0x4);
        voter = new Voter(
            address(votingEscrow),
            mockSyndicateFactory,
            block.timestamp, // Epoch start reference
            owner
        );

        // Deploy minter with real addresses
        minter = new Minter(address(wood), address(voter), address(votingEscrow), treasury, owner);

        // Link minter to wood token
        wood.setMinter(address(minter));

        vm.stopPrank();
    }

    function testVotingEscrowBasics() public {
        // Give user some WOOD tokens
        vm.prank(owner);
        wood.ownerMint(user, 1000e18);

        // User locks WOOD for voting escrow
        vm.startPrank(user);
        wood.approve(address(votingEscrow), 1000e18);

        uint256 unlockTime = block.timestamp + 365 days; // 1 year
        uint256 tokenId = votingEscrow.createLock(100e18, unlockTime, false);

        // Verify lock was created
        assertEq(tokenId, 1);
        assertEq(votingEscrow.ownerOf(tokenId), user);

        // Check voting power (should be close to locked amount for 1-year lock)
        uint256 votingPower = votingEscrow.balanceOfNFT(tokenId);
        assertTrue(votingPower > 90e18 && votingPower <= 100e18); // Close to full power

        // Check total supply
        uint256 totalSupply = votingEscrow.totalSupply();
        assertTrue(totalSupply > 90e18 && totalSupply <= 100e18);

        vm.stopPrank();
    }

    function testAutoMaxLock() public {
        // Give user some WOOD tokens
        vm.prank(owner);
        wood.ownerMint(user, 1000e18);

        vm.startPrank(user);
        wood.approve(address(votingEscrow), 1000e18);

        // Create auto-max-lock (no decay)
        uint256 tokenId = votingEscrow.createLock(100e18, 0, true); // unlockTime ignored for auto-max-lock

        // Verify voting power is exactly the locked amount (no decay)
        uint256 votingPower = votingEscrow.balanceOfNFT(tokenId);
        assertEq(votingPower, 100e18);

        // Move forward in time
        vm.warp(block.timestamp + 180 days); // 6 months

        // Voting power should still be full (no decay)
        uint256 votingPowerAfter = votingEscrow.balanceOfNFT(tokenId);
        assertEq(votingPowerAfter, 100e18);

        vm.stopPrank();
    }

    function testIncreaseAmount() public {
        // Give user some WOOD tokens
        vm.prank(owner);
        wood.ownerMint(user, 1000e18);

        vm.startPrank(user);
        wood.approve(address(votingEscrow), 1000e18);

        uint256 unlockTime = block.timestamp + 365 days;
        uint256 tokenId = votingEscrow.createLock(100e18, unlockTime, false);

        // Increase lock amount
        votingEscrow.increaseAmount(tokenId, 50e18);

        // Voting power should increase
        uint256 votingPower = votingEscrow.balanceOfNFT(tokenId);
        assertTrue(votingPower > 140e18 && votingPower <= 150e18); // Close to 150

        vm.stopPrank();
    }

    function testWoodMinting() public {
        // Test that Minter can mint WOOD tokens
        vm.prank(address(minter));
        uint256 minted = wood.mint(user, 100e18);
        assertEq(minted, 100e18);
        assertEq(wood.balanceOf(user), 100e18);

        // Test supply cap
        uint256 remaining = wood.totalMintable();
        assertEq(remaining, wood.MAX_SUPPLY() - 100e18);
    }

    function testVoterBasics() public {
        vm.prank(owner);
        voter.startVoting();

        assertTrue(voter.currentEpoch() == 1);
        assertTrue(voter.EPOCH_DURATION() == 7 days);
        assertTrue(voter.QUORUM_THRESHOLD() == 1000); // 10%
        assertTrue(voter.MAX_SYNDICATE_SHARE() == 2500); // 25%
    }

    function testGetTokenIds() public {
        // Give user some WOOD tokens
        vm.prank(owner);
        wood.ownerMint(user, 1000e18);

        vm.startPrank(user);
        wood.approve(address(votingEscrow), 1000e18);

        // Create multiple locks
        uint256 tokenId1 = votingEscrow.createLock(100e18, block.timestamp + 365 days, false);
        uint256 tokenId2 = votingEscrow.createLock(50e18, block.timestamp + 180 days, true);

        // Check user owns both tokens
        uint256[] memory tokenIds = votingEscrow.getTokenIds(user);
        assertEq(tokenIds.length, 2);
        assertEq(tokenIds[0], tokenId1);
        assertEq(tokenIds[1], tokenId2);

        vm.stopPrank();
    }
}