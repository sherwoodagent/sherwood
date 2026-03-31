// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockWoodToken} from "../src/MockWoodToken.sol";
import {VotingEscrow} from "../src/VotingEscrow.sol";

/// @title VotingEscrowSimpleTest — Simplified tests for VotingEscrow contract
contract VotingEscrowSimpleTest is Test {
    MockWoodToken public wood;
    VotingEscrow public votingEscrow;

    address public owner = address(0x1);
    address public user1 = address(0x2);

    uint256 constant LOCK_AMOUNT = 100e18;
    uint256 constant MIN_LOCK = 4 weeks;
    uint256 constant MAX_LOCK = 365 days;

    function setUp() public {
        vm.startPrank(owner);
        wood = new MockWoodToken(owner);
        votingEscrow = new VotingEscrow(address(wood), owner);

        wood.ownerMint(user1, 10000e18);
        vm.stopPrank();

        vm.prank(user1);
        wood.approve(address(votingEscrow), type(uint256).max);
    }

    function testBasicLockCreation() public {
        vm.prank(user1);
        uint256 tokenId = votingEscrow.createLock(LOCK_AMOUNT, block.timestamp + MAX_LOCK, false);

        assertEq(tokenId, 1);
        assertEq(votingEscrow.ownerOf(tokenId), user1);
        assertGt(votingEscrow.balanceOfNFT(tokenId), 0);
    }

    function testVotingPowerDecay() public {
        vm.prank(user1);
        uint256 tokenId = votingEscrow.createLock(LOCK_AMOUNT, block.timestamp + MAX_LOCK, false);

        uint256 initialPower = votingEscrow.balanceOfNFT(tokenId);

        // Move forward 6 months
        vm.warp(block.timestamp + 182 days);
        uint256 laterPower = votingEscrow.balanceOfNFT(tokenId);

        assertLt(laterPower, initialPower);
    }

    function testAutoMaxLock() public {
        vm.prank(user1);
        uint256 tokenId = votingEscrow.createLock(LOCK_AMOUNT, 0, true);

        uint256 initialPower = votingEscrow.balanceOfNFT(tokenId);
        assertEq(initialPower, LOCK_AMOUNT);

        // Move forward - should maintain power
        vm.warp(block.timestamp + 180 days);
        uint256 laterPower = votingEscrow.balanceOfNFT(tokenId);
        assertEq(laterPower, LOCK_AMOUNT);
    }

    function testIncreaseAmount() public {
        vm.prank(user1);
        uint256 tokenId = votingEscrow.createLock(LOCK_AMOUNT, block.timestamp + MAX_LOCK, false);

        uint256 initialPower = votingEscrow.balanceOfNFT(tokenId);

        vm.prank(user1);
        votingEscrow.increaseAmount(tokenId, 50e18);

        uint256 newPower = votingEscrow.balanceOfNFT(tokenId);
        assertGt(newPower, initialPower);
    }

    function testWithdrawAfterExpiry() public {
        vm.prank(user1);
        uint256 tokenId = votingEscrow.createLock(LOCK_AMOUNT, block.timestamp + MIN_LOCK, false);

        // Move to expiry
        vm.warp(block.timestamp + MIN_LOCK);

        uint256 balanceBefore = wood.balanceOf(user1);

        vm.prank(user1);
        votingEscrow.withdraw(tokenId);

        uint256 balanceAfter = wood.balanceOf(user1);
        assertEq(balanceAfter - balanceBefore, LOCK_AMOUNT);
    }

    function testCannotWithdrawBeforeExpiry() public {
        vm.prank(user1);
        uint256 tokenId = votingEscrow.createLock(LOCK_AMOUNT, block.timestamp + MAX_LOCK, false);

        vm.prank(user1);
        vm.expectRevert();
        votingEscrow.withdraw(tokenId);
    }

    function testGetTokenIds() public {
        vm.prank(user1);
        uint256 tokenId1 = votingEscrow.createLock(LOCK_AMOUNT, block.timestamp + MAX_LOCK, false);

        vm.prank(user1);
        uint256 tokenId2 = votingEscrow.createLock(LOCK_AMOUNT, block.timestamp + MAX_LOCK, false);

        uint256[] memory tokenIds = votingEscrow.getTokenIds(user1);
        assertEq(tokenIds.length, 2);
        assertEq(tokenIds[0], tokenId1);
        assertEq(tokenIds[1], tokenId2);
    }

    function testConstants() public {
        assertEq(votingEscrow.MIN_LOCK_DURATION(), 4 weeks);
        assertEq(votingEscrow.MAX_LOCK_DURATION(), 365 days);
    }
}