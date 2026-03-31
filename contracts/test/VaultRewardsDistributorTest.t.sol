// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockWoodToken} from "../src/MockWoodToken.sol";
import {VotingEscrow} from "../src/VotingEscrow.sol";
import {Voter} from "../src/Voter.sol";
import {Minter} from "../src/Minter.sol";
import {VaultRewardsDistributor} from "../src/VaultRewardsDistributor.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";

/// @notice Mock vault that implements ERC20Votes for testing VaultRewardsDistributor
/// @dev Uses timestamp-based clock to match VaultRewardsDistributor which passes timestamps to getPastVotes
contract MockVault is ERC20, ERC20Permit, ERC20Votes {
    constructor() ERC20("Mock Vault", "mvToken") ERC20Permit("Mock Vault") {}

    function mintShares(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // Use timestamps instead of block numbers for checkpoints
    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    // Override required functions
    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}

/// @title VaultRewardsDistributorTest — Tests for vault rewards distribution
contract VaultRewardsDistributorTest is Test {
    MockWoodToken public wood;
    VotingEscrow public votingEscrow;
    Voter public voter;
    Minter public minter;
    MockVault public mockVault;
    VaultRewardsDistributor public distributor;

    address public owner = address(0x1);
    address public user1 = address(0x2);
    address public user2 = address(0x3);
    address public treasury = address(0x4);
    address public mockFactory = address(0x5);

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

        // 7. Deploy MockVault
        mockVault = new MockVault();

        // 8. Deploy VaultRewardsDistributor
        distributor = new VaultRewardsDistributor(
            address(mockVault),
            address(wood),
            treasury,
            address(voter),
            owner
        );

        vm.stopPrank();

        // Setup users with vault shares
        mockVault.mintShares(user1, 1000e18);
        mockVault.mintShares(user2, 500e18);

        // CRITICAL: Users must delegate to themselves to activate checkpoints
        vm.prank(user1);
        mockVault.delegate(user1);
        vm.prank(user2);
        mockVault.delegate(user2);

        // CRITICAL: Advance block so ERC5805 checkpoints are in the past
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);

        // Give distributor some WOOD to distribute
        vm.prank(owner);
        wood.ownerMint(address(distributor), 10000e18);

        // Give distributor approval to spend WOOD for testing depositRewards
        vm.prank(owner);
        wood.ownerMint(owner, 50000e18);
        vm.prank(owner);
        wood.approve(address(distributor), type(uint256).max);
    }

    function testDepositRewards() public {
        uint256 epoch = 1;
        uint256 amount = 1000e18;

        // Use proper epoch start time and warp past it for checkpoints
        uint256 epochStart = voter.getEpochStart(epoch);
        vm.warp(epochStart + 1 hours);

        vm.prank(owner);
        distributor.depositRewards(epoch, amount);

        VaultRewardsDistributor.RewardPool memory pool = distributor.getRewardPool(epoch);
        assertEq(pool.totalRewards, amount);
        assertEq(pool.totalClaimed, 0);
        assertEq(pool.expiryTimestamp, voter.getEpochStart(epoch) + (52 * 7 days));
        assertFalse(pool.expired);
    }

    function testCannotDepositZeroAmount() public {
        uint256 epoch = 1;

        vm.expectRevert(VaultRewardsDistributor.InvalidAmount.selector);
        vm.prank(owner);
        distributor.depositRewards(epoch, 0);
    }

    function testCannotDepositTwiceForSameEpoch() public {
        uint256 epoch = 1;
        uint256 amount = 1000e18;

        uint256 epochStart = voter.getEpochStart(epoch);
        vm.warp(epochStart + 1 hours);

        vm.prank(owner);
        distributor.depositRewards(epoch, amount);

        vm.expectRevert(VaultRewardsDistributor.InvalidEpoch.selector);
        vm.prank(owner);
        distributor.depositRewards(epoch, amount);
    }

    function testClaimRewards() public {
        uint256 epoch = 1;
        uint256 rewardAmount = 1000e18;

        // Use proper epoch start time and warp past it for checkpoints
        uint256 epochStart = voter.getEpochStart(epoch);
        vm.warp(epochStart + 1 hours);

        vm.prank(owner);
        distributor.depositRewards(epoch, rewardAmount);

        uint256 user1BalanceBefore = wood.balanceOf(user1);

        vm.prank(user1);
        uint256 claimed = distributor.claimRewards(epoch);

        uint256 user1BalanceAfter = wood.balanceOf(user1);

        // user1 has 1000 shares out of 1500 total = 2/3 of rewards
        uint256 expectedReward = (rewardAmount * 1000e18) / 1500e18;
        assertEq(claimed, expectedReward);
        assertEq(user1BalanceAfter - user1BalanceBefore, expectedReward);

        // Check claim status
        assertTrue(distributor.hasClaimed(user1, epoch));
    }

    function testMultipleUsersClaimProportionally() public {
        uint256 epoch = 1;
        uint256 rewardAmount = 1500e18; // Divisible by total shares for clean math

        uint256 epochStart = voter.getEpochStart(epoch);
        vm.warp(epochStart + 1 hours);

        vm.prank(owner);
        distributor.depositRewards(epoch, rewardAmount);

        uint256 user1BalanceBefore = wood.balanceOf(user1);
        uint256 user2BalanceBefore = wood.balanceOf(user2);

        vm.prank(user1);
        uint256 user1Claimed = distributor.claimRewards(epoch);

        vm.prank(user2);
        uint256 user2Claimed = distributor.claimRewards(epoch);

        // user1: 1000/1500 = 2/3, user2: 500/1500 = 1/3
        uint256 expectedUser1Reward = (rewardAmount * 1000e18) / 1500e18;
        uint256 expectedUser2Reward = (rewardAmount * 500e18) / 1500e18;

        assertEq(user1Claimed, expectedUser1Reward);
        assertEq(user2Claimed, expectedUser2Reward);

        assertEq(wood.balanceOf(user1) - user1BalanceBefore, expectedUser1Reward);
        assertEq(wood.balanceOf(user2) - user2BalanceBefore, expectedUser2Reward);
    }

    function testCannotDoubleClaimSameEpoch() public {
        uint256 epoch = 1;
        uint256 rewardAmount = 1000e18;

        uint256 epochStart = voter.getEpochStart(epoch);
        vm.warp(epochStart + 1 hours);

        vm.prank(owner);
        distributor.depositRewards(epoch, rewardAmount);

        vm.prank(user1);
        distributor.claimRewards(epoch);

        vm.expectRevert(VaultRewardsDistributor.AlreadyClaimed.selector);
        vm.prank(user1);
        distributor.claimRewards(epoch);
    }

    function testZeroBalanceGetsZeroRewards() public {
        uint256 epoch = 1;
        uint256 rewardAmount = 1000e18;
        address userWithNoShares = address(0x99);

        uint256 epochStart = voter.getEpochStart(epoch);
        vm.warp(epochStart + 1 hours);

        vm.prank(owner);
        distributor.depositRewards(epoch, rewardAmount);

        vm.expectRevert(VaultRewardsDistributor.NoRewardsToClaim.selector);
        vm.prank(userWithNoShares);
        distributor.claimRewards(epoch);
    }

    function testCannotClaimExpiredRewards() public {
        uint256 epoch = 1;
        uint256 rewardAmount = 1000e18;

        uint256 epochStart = voter.getEpochStart(epoch);
        vm.warp(epochStart + 1 hours);

        vm.prank(owner);
        distributor.depositRewards(epoch, rewardAmount);

        // Warp past expiry (52 weeks later)
        vm.warp(epochStart + (52 * 7 days) + 1);

        vm.expectRevert(VaultRewardsDistributor.RewardsExpiredError.selector);
        vm.prank(user1);
        distributor.claimRewards(epoch);
    }

    function testReturnExpiredRewards() public {
        uint256 epoch = 1;
        uint256 rewardAmount = 1000e18;

        uint256 epochStart = voter.getEpochStart(epoch);
        vm.warp(epochStart + 1 hours);

        vm.prank(owner);
        distributor.depositRewards(epoch, rewardAmount);

        uint256 treasuryBalanceBefore = wood.balanceOf(treasury);

        // Warp past expiry
        vm.warp(epochStart + (52 * 7 days) + 1);

        distributor.returnExpiredRewards(epoch);

        uint256 treasuryBalanceAfter = wood.balanceOf(treasury);
        assertEq(treasuryBalanceAfter - treasuryBalanceBefore, rewardAmount);

        VaultRewardsDistributor.RewardPool memory pool = distributor.getRewardPool(epoch);
        assertTrue(pool.expired);
    }

    function testClaimMultipleEpochs() public {
        uint256 rewardAmount = 1000e18;

        // Warp well past epoch 2 start so both epoch checkpoints are in the past
        uint256 epoch2Start = voter.getEpochStart(2);
        vm.warp(epoch2Start + 1 hours);
        vm.roll(block.number + 10);

        vm.prank(owner);
        distributor.depositRewards(1, rewardAmount);

        vm.prank(owner);
        distributor.depositRewards(2, rewardAmount);

        uint256[] memory epochs = new uint256[](2);
        epochs[0] = 1;
        epochs[1] = 2;

        uint256 user1BalanceBefore = wood.balanceOf(user1);

        vm.prank(user1);
        uint256 totalClaimed = distributor.claimMultipleEpochs(epochs);

        uint256 user1BalanceAfter = wood.balanceOf(user1);

        // Should claim from both epochs
        uint256 expectedPerEpoch = (rewardAmount * 1000e18) / 1500e18;
        uint256 expectedTotal = expectedPerEpoch * 2;

        assertEq(totalClaimed, expectedTotal);
        assertEq(user1BalanceAfter - user1BalanceBefore, expectedTotal);

        assertTrue(distributor.hasClaimed(user1, 1));
        assertTrue(distributor.hasClaimed(user1, 2));
    }

    function testGetPendingRewards() public {
        uint256 epoch = 1;
        uint256 rewardAmount = 1000e18;

        uint256 epochStart = voter.getEpochStart(epoch);
        vm.warp(epochStart + 1 hours);

        vm.prank(owner);
        distributor.depositRewards(epoch, rewardAmount);

        uint256 pending = distributor.getPendingRewards(user1, epoch);
        uint256 expected = (rewardAmount * 1000e18) / 1500e18;
        assertEq(pending, expected);

        // After claiming, pending should be 0
        vm.prank(user1);
        distributor.claimRewards(epoch);

        pending = distributor.getPendingRewards(user1, epoch);
        assertEq(pending, 0);
    }

    function testGetClaimableEpochs() public {
        uint256 rewardAmount = 1000e18;

        uint256 epochStart = voter.getEpochStart(1);
        vm.warp(epochStart + 1 hours);

        vm.prank(owner);
        distributor.depositRewards(1, rewardAmount);

        uint256[] memory claimable = distributor.getClaimableEpochs(user1);
        assertEq(claimable.length, 1);
        assertEq(claimable[0], 1);

        // After claiming epoch 1, should be empty
        vm.prank(user1);
        distributor.claimRewards(1);

        claimable = distributor.getClaimableEpochs(user1);
        assertEq(claimable.length, 0);
    }

    function testConstants() public {
        assertEq(distributor.CLAIM_WINDOW(), 52);
        assertEq(address(distributor.syndicateVault()), address(mockVault));
        assertEq(address(distributor.wood()), address(wood));
        assertEq(distributor.treasury(), treasury);
        assertEq(address(distributor.voter()), address(voter));
    }

    function testTotalTracking() public {
        uint256 epoch = 1;
        uint256 rewardAmount = 1000e18;

        uint256 epochStart = voter.getEpochStart(epoch);
        vm.warp(epochStart + 1 hours);

        vm.prank(owner);
        distributor.depositRewards(epoch, rewardAmount);

        assertEq(distributor.getTotalRewardsDeposited(), rewardAmount);
        assertEq(distributor.getTotalRewardsClaimed(), 0);

        vm.prank(user1);
        uint256 claimed = distributor.claimRewards(epoch);

        assertEq(distributor.getTotalRewardsDeposited(), rewardAmount);
        assertEq(distributor.getTotalRewardsClaimed(), claimed);
    }
}