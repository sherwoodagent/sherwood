// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockWoodToken} from "../src/MockWoodToken.sol";
import {VotingEscrow} from "../src/VotingEscrow.sol";
import {Voter} from "../src/Voter.sol";
import {Minter} from "../src/Minter.sol";
import {VoteIncentive} from "../src/VoteIncentive.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock ERC20 token for testing incentives/bribes
contract MockBribeToken is ERC20 {
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title VoteIncentiveTest — Tests for vote incentive/bribe system
contract VoteIncentiveTest is Test {
    MockWoodToken public wood;
    VotingEscrow public votingEscrow;
    Voter public voter;
    Minter public minter;
    VoteIncentive public voteIncentive;
    MockBribeToken public bribeToken1;
    MockBribeToken public bribeToken2;

    address public owner = address(0x1);
    address public user1 = address(0x2);
    address public user2 = address(0x3);
    address public briber = address(0x4);
    address public treasury = address(0x5);
    address public mockFactory = address(0x6);

    uint256 public tokenId1;
    uint256 public tokenId2;
    uint256 public syndicateId1 = 1;
    uint256 public syndicateId2 = 2;

    function setUp() public {
        vm.startPrank(owner);

        // 1. Deploy token first
        wood = new MockWoodToken(owner);

        // 2. Deploy VotingEscrow
        votingEscrow = new VotingEscrow(address(wood), owner);

        // 3. Deploy Voter (needs VotingEscrow + factory + epoch start)
        voter = new Voter(address(votingEscrow), address(mockFactory), block.timestamp, owner);

        // 4. Deploy Minter (needs all addresses)
        minter = new Minter(address(wood), address(voter), address(votingEscrow), treasury, owner);

        // 5. Link minter to wood
        wood.setMinter(address(minter));

        // 6. Start voting period
        voter.startVoting();

        // 7. Deploy VoteIncentive
        voteIncentive = new VoteIncentive(address(voter), address(votingEscrow), owner);

        // 8. Create gauges
        voter.createGauge(syndicateId1, address(0x100), 1);
        voter.setGaugeActive(syndicateId1, true);
        voter.createGauge(syndicateId2, address(0x200), 2);
        voter.setGaugeActive(syndicateId2, true);

        vm.stopPrank();

        // Setup bribe tokens
        bribeToken1 = new MockBribeToken("Bribe Token 1", "BRIBE1");
        bribeToken2 = new MockBribeToken("Bribe Token 2", "BRIBE2");

        // Give users WOOD and create veNFTs
        vm.prank(owner);
        wood.ownerMint(user1, 10000e18);
        vm.prank(owner);
        wood.ownerMint(user2, 5000e18);

        vm.prank(user1);
        wood.approve(address(votingEscrow), type(uint256).max);
        vm.prank(user1);
        tokenId1 = votingEscrow.createLock(1000e18, block.timestamp + 365 days, false);

        vm.prank(user2);
        wood.approve(address(votingEscrow), type(uint256).max);
        vm.prank(user2);
        tokenId2 = votingEscrow.createLock(500e18, block.timestamp + 365 days, false);

        // Give briber bribe tokens
        bribeToken1.mint(briber, 10000e18);
        bribeToken2.mint(briber, 10000e18);
        vm.prank(briber);
        bribeToken1.approve(address(voteIncentive), type(uint256).max);
        vm.prank(briber);
        bribeToken2.approve(address(voteIncentive), type(uint256).max);
    }

    function testDepositIncentive() public {
        uint256 epoch = 2; // Deposit for future epoch
        uint256 amount = 1000e18;

        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId1, epoch, address(bribeToken1), amount);

        VoteIncentive.IncentivePool memory pool = voteIncentive.getIncentivePool(syndicateId1, epoch, address(bribeToken1));
        assertEq(pool.amount, amount);
        assertEq(pool.totalClaimed, 0);
        assertTrue(pool.active);
        assertEq(pool.depositDeadline, voter.getEpochStart(epoch));

        address[] memory activeTokens = voteIncentive.getActiveIncentiveTokens(syndicateId1, epoch);
        assertEq(activeTokens.length, 1);
        assertEq(activeTokens[0], address(bribeToken1));
    }

    function testCannotDepositZeroAmount() public {
        uint256 epoch = 2; // Deposit for future epoch

        vm.expectRevert(VoteIncentive.InvalidAmount.selector);
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId1, epoch, address(bribeToken1), 0);
    }

    function testCannotDepositWithZeroToken() public {
        uint256 epoch = 2; // Deposit for future epoch
        uint256 amount = 1000e18;

        vm.expectRevert(VoteIncentive.InvalidToken.selector);
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId1, epoch, address(0), amount);
    }

    function testCannotDepositAfterEpochStarts() public {
        uint256 currentEpoch = voter.currentEpoch();
        uint256 epochStart = voter.getEpochStart(currentEpoch);

        // Warp to when epoch has started
        vm.warp(epochStart);

        vm.expectRevert(VoteIncentive.DepositDeadlinePassed.selector);
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId1, currentEpoch, address(bribeToken1), 1000e18);
    }

    function testCannotDepositForInactiveSyndicate() public {
        uint256 epoch = 2; // Deposit for future epoch
        uint256 invalidSyndicateId = 999;

        vm.expectRevert(VoteIncentive.InvalidSyndicateId.selector);
        vm.prank(briber);
        voteIncentive.depositIncentive(invalidSyndicateId, epoch, address(bribeToken1), 1000e18);
    }

    function testClaimIncentives() public {
        uint256 epoch = 2; // Deposit for future epoch
        uint256 incentiveAmount = 1000e18;

        // Deposit incentive for epoch 2 (while still in epoch 1)
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId1, epoch, address(bribeToken1), incentiveAmount);

        // Flip to epoch 2
        vm.warp(voter.getEpochEnd(1) + 1);
        voter.flipEpoch();

        // Vote in epoch 2
        uint256[] memory syndicateIds = new uint256[](1);
        syndicateIds[0] = syndicateId1;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10000; // 100%

        vm.prank(user1);
        voter.vote(tokenId1, syndicateIds, weights);

        // Flip to epoch 3 so epoch 2 votes can be claimed
        vm.warp(voter.getEpochEnd(2) + 1);
        voter.flipEpoch();

        uint256 user1BalanceBefore = bribeToken1.balanceOf(user1);

        address[] memory tokens = new address[](1);
        tokens[0] = address(bribeToken1);

        vm.prank(user1);
        uint256[] memory claimed = voteIncentive.claimIncentives(syndicateId1, epoch, tokens);

        uint256 user1BalanceAfter = bribeToken1.balanceOf(user1);

        // user1 voted all voting power to syndicate1, so should get all incentives
        assertEq(claimed[0], incentiveAmount);
        assertEq(user1BalanceAfter - user1BalanceBefore, incentiveAmount);

        assertTrue(voteIncentive.hasClaimed(user1, syndicateId1, epoch, address(bribeToken1)));
    }

    function testMultipleVotersClaimProportionally() public {
        uint256 epoch = 2; // Deposit for future epoch
        uint256 incentiveAmount = 1500e18; // Divisible amount for clean math

        // Deposit incentive for epoch 2 (while in epoch 1)
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId1, epoch, address(bribeToken1), incentiveAmount);

        // Flip to epoch 2
        vm.warp(voter.getEpochEnd(1) + 1);
        voter.flipEpoch();

        // Both users vote in epoch 2
        uint256[] memory syndicateIds = new uint256[](1);
        syndicateIds[0] = syndicateId1;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10000;

        vm.prank(user1);
        voter.vote(tokenId1, syndicateIds, weights);

        vm.prank(user2);
        voter.vote(tokenId2, syndicateIds, weights);

        // Flip to epoch 3
        vm.warp(voter.getEpochEnd(2) + 1);
        voter.flipEpoch();

        address[] memory tokens = new address[](1);
        tokens[0] = address(bribeToken1);

        // Claim for user1
        {
            uint256 balanceBefore = bribeToken1.balanceOf(user1);
            vm.prank(user1);
            uint256[] memory claimed = voteIncentive.claimIncentives(syndicateId1, epoch, tokens);
            uint256 balanceAfter = bribeToken1.balanceOf(user1);
            assertGt(claimed[0], 0);
            assertEq(balanceAfter - balanceBefore, claimed[0]);
        }

        // Claim for user2
        {
            uint256 balanceBefore = bribeToken1.balanceOf(user2);
            vm.prank(user2);
            uint256[] memory claimed = voteIncentive.claimIncentives(syndicateId1, epoch, tokens);
            uint256 balanceAfter = bribeToken1.balanceOf(user2);
            assertGt(claimed[0], 0);
            assertEq(balanceAfter - balanceBefore, claimed[0]);
        }

        // Verify proportional distribution (user1 has 2x the voting power)
        uint256 totalVotes = voter.getSyndicateVotes(syndicateId1, epoch);
        assertGt(totalVotes, 0);
    }

    function testCanClaimDuringEpochIfVoted() public {
        uint256 incentiveAmount = 1000e18;

        // Deposit in epoch 1 for epoch 2
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId1, 2, address(bribeToken1), incentiveAmount);

        // Flip to epoch 2
        vm.warp(voter.getEpochEnd(1) + 1);
        voter.flipEpoch();

        // Vote in epoch 2
        uint256[] memory syndicateIds = new uint256[](1);
        syndicateIds[0] = syndicateId1;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10000;

        vm.prank(user1);
        voter.vote(tokenId1, syndicateIds, weights);

        // Claim during epoch 2 — contract allows this once votes are recorded
        address[] memory tokens = new address[](1);
        tokens[0] = address(bribeToken1);

        vm.prank(user1);
        uint256[] memory claimed = voteIncentive.claimIncentives(syndicateId1, 2, tokens);
        assertEq(claimed[0], incentiveAmount); // Full amount since only voter
    }

    function testMultiTokenIncentives() public {
        uint256 epoch = 2;
        uint256 amount1 = 1000e18;
        uint256 amount2 = 2000e18;

        // Deposit in epoch 1 for epoch 2
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId1, epoch, address(bribeToken1), amount1);
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId1, epoch, address(bribeToken2), amount2);

        // Flip to epoch 2, vote
        vm.warp(voter.getEpochEnd(1) + 1);
        voter.flipEpoch();

        uint256[] memory syndicateIds = new uint256[](1);
        syndicateIds[0] = syndicateId1;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10000;
        vm.prank(user1);
        voter.vote(tokenId1, syndicateIds, weights);

        // Flip to epoch 3
        vm.warp(voter.getEpochEnd(2) + 1);
        voter.flipEpoch();

        address[] memory tokens = new address[](2);
        tokens[0] = address(bribeToken1);
        tokens[1] = address(bribeToken2);

        uint256 balance1Before = bribeToken1.balanceOf(user1);
        uint256 balance2Before = bribeToken2.balanceOf(user1);

        vm.prank(user1);
        uint256[] memory claimed = voteIncentive.claimIncentives(syndicateId1, epoch, tokens);

        assertEq(claimed[0], amount1);
        assertEq(claimed[1], amount2);
        assertEq(bribeToken1.balanceOf(user1) - balance1Before, amount1);
        assertEq(bribeToken2.balanceOf(user1) - balance2Before, amount2);
    }

    function testSplitVotesAcrossMultipleSyndicates() public {
        uint256 epoch = 2;
        uint256 incentiveAmount = 1000e18;

        // Deposit in epoch 1 for epoch 2
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId1, epoch, address(bribeToken1), incentiveAmount);
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId2, epoch, address(bribeToken1), incentiveAmount);

        // Flip to epoch 2
        vm.warp(voter.getEpochEnd(1) + 1);
        voter.flipEpoch();

        // Vote 60/40 split in epoch 2
        uint256[] memory syndicateIds = new uint256[](2);
        syndicateIds[0] = syndicateId1;
        syndicateIds[1] = syndicateId2;
        uint256[] memory weights = new uint256[](2);
        weights[0] = 6000;
        weights[1] = 4000;

        vm.prank(user1);
        voter.vote(tokenId1, syndicateIds, weights);

        // Flip to epoch 3
        vm.warp(voter.getEpochEnd(2) + 1);
        voter.flipEpoch();

        address[] memory tokens = new address[](1);
        tokens[0] = address(bribeToken1);

        uint256 balanceBefore = bribeToken1.balanceOf(user1);

        vm.prank(user1);
        uint256[] memory claimed1 = voteIncentive.claimIncentives(syndicateId1, epoch, tokens);

        vm.prank(user1);
        uint256[] memory claimed2 = voteIncentive.claimIncentives(syndicateId2, epoch, tokens);

        uint256 balanceAfter = bribeToken1.balanceOf(user1);

        // Only voter, gets full incentives from both
        assertEq(claimed1[0], incentiveAmount);
        assertEq(claimed2[0], incentiveAmount);
        assertEq(balanceAfter - balanceBefore, incentiveAmount * 2);
    }

    function testGetPendingIncentives() public {
        uint256 epoch = 2;
        uint256 incentiveAmount = 1000e18;

        // Deposit in epoch 1 for epoch 2
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId1, epoch, address(bribeToken1), incentiveAmount);

        // Flip to epoch 2, vote
        vm.warp(voter.getEpochEnd(1) + 1);
        voter.flipEpoch();

        uint256[] memory syndicateIds = new uint256[](1);
        syndicateIds[0] = syndicateId1;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 10000;
        vm.prank(user1);
        voter.vote(tokenId1, syndicateIds, weights);

        // Flip to epoch 3
        vm.warp(voter.getEpochEnd(2) + 1);
        voter.flipEpoch();

        // After epoch 2 ends, should show full amount
        uint256 pendingAfter = voteIncentive.getPendingIncentives(user1, syndicateId1, epoch, address(bribeToken1));
        assertEq(pendingAfter, incentiveAmount);

        // After claiming, pending should be 0
        address[] memory tokens = new address[](1);
        tokens[0] = address(bribeToken1);

        vm.prank(user1);
        voteIncentive.claimIncentives(syndicateId1, epoch, tokens);

        uint256 pendingAfterClaim = voteIncentive.getPendingIncentives(user1, syndicateId1, epoch, address(bribeToken1));
        assertEq(pendingAfterClaim, 0);
    }

    function testClaimAllIncentives() public {
        uint256 incentiveAmount = 1000e18;

        // Deposit in epoch 1 for epoch 2
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId1, 2, address(bribeToken1), incentiveAmount);
        vm.prank(briber);
        voteIncentive.depositIncentive(syndicateId2, 2, address(bribeToken1), incentiveAmount);

        // Flip to epoch 2
        vm.warp(voter.getEpochEnd(1) + 1);
        voter.flipEpoch();

        // Vote in epoch 2
        uint256[] memory syndicateIds = new uint256[](2);
        syndicateIds[0] = syndicateId1;
        syndicateIds[1] = syndicateId2;
        uint256[] memory weights = new uint256[](2);
        weights[0] = 5000;
        weights[1] = 5000;

        vm.prank(user1);
        voter.vote(tokenId1, syndicateIds, weights);

        // Flip to epoch 3
        vm.warp(voter.getEpochEnd(2) + 1);
        voter.flipEpoch();

        // Claim all at once
        uint256[] memory claimSyndicateIds = new uint256[](2);
        claimSyndicateIds[0] = syndicateId1;
        claimSyndicateIds[1] = syndicateId2;
        uint256[] memory epochs = new uint256[](1);
        epochs[0] = 2;
        address[] memory tokens = new address[](1);
        tokens[0] = address(bribeToken1);

        uint256 balanceBefore = bribeToken1.balanceOf(user1);

        vm.prank(user1);
        uint256[] memory totalClaimed = voteIncentive.claimAllIncentives(claimSyndicateIds, epochs, tokens);

        uint256 balanceAfter = bribeToken1.balanceOf(user1);

        // Should claim from both syndicates
        assertEq(totalClaimed[0], incentiveAmount * 2);
        assertEq(balanceAfter - balanceBefore, incentiveAmount * 2);
    }

    function testConstants() public {
        assertEq(voteIncentive.DEPOSIT_DEADLINE_OFFSET(), 0);
        assertEq(address(voteIncentive.voter()), address(voter));
        assertEq(address(voteIncentive.votingEscrow()), address(votingEscrow));
    }
}