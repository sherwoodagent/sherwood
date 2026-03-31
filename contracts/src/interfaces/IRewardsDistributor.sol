// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IRewardsDistributor — veWOOD rebase (anti-dilution) distribution
/// @notice Interface for RewardsDistributor that distributes rebase rewards
///         to veWOOD holders proportional to their locked amounts.
interface IRewardsDistributor {

    // ==================== STRUCTS ====================

    /// @notice Rebase distribution for an epoch
    struct RebaseDistribution {
        uint256 totalRebase;        // Total rebase amount for epoch
        uint256 totalLocked;        // Total WOOD locked at distribution time
        uint256 distributionTime;   // When distribution was calculated
        bool processed;             // Whether distribution was processed
    }

    /// @notice Claim information for a veNFT
    struct RebaseClaim {
        uint256 amount;             // Claimable rebase amount
        bool claimed;               // Whether already claimed
    }

    // ==================== EVENTS ====================

    event RebaseDistributed(uint256 indexed epoch, uint256 totalRebase, uint256 totalLocked);

    event RebaseClaimed(
        address indexed claimer,
        uint256 indexed tokenId,
        uint256 indexed epoch,
        uint256 amount,
        uint256 lockedAmount,
        uint256 totalLocked
    );

    // ==================== ERRORS ====================

    error NotAuthorized();
    error InvalidEpoch();
    error NoRebaseToClaim();
    error AlreadyClaimed();
    error DistributionNotReady();
    error InvalidTokenId();
    error TokenNotOwned();

    // ==================== CORE FUNCTIONS ====================

    /// @notice Distribute rebase rewards for an epoch
    /// @param epoch The epoch number
    /// @param rebaseAmount Total WOOD rebase amount to distribute
    /// @dev Only callable by Minter contract
    function distributeRebase(uint256 epoch, uint256 rebaseAmount) external;

    /// @notice Claim rebase rewards for a veNFT in a specific epoch
    /// @param tokenId The veNFT to claim for
    /// @param epoch The epoch to claim from
    /// @return amount Amount of WOOD claimed
    function claimRebase(uint256 tokenId, uint256 epoch) external returns (uint256 amount);

    /// @notice Claim rebase rewards across multiple epochs for a veNFT
    /// @param tokenId The veNFT to claim for
    /// @param epochs Array of epochs to claim from
    /// @return totalAmount Total WOOD claimed across all epochs
    function claimMultipleEpochs(uint256 tokenId, uint256[] calldata epochs) external returns (uint256 totalAmount);

    /// @notice Claim rebase rewards for all epochs since last claim
    /// @param tokenId The veNFT to claim for
    /// @return totalAmount Total WOOD claimed
    function claimAll(uint256 tokenId) external returns (uint256 totalAmount);

    // ==================== VIEW FUNCTIONS ====================

    /// @notice Calculate pending rebase rewards for a veNFT in an epoch
    /// @param tokenId The veNFT to check
    /// @param epoch The epoch number
    /// @return reward Pending rebase amount
    function getPendingRebase(uint256 tokenId, uint256 epoch) external view returns (uint256 reward);

    /// @notice Calculate pending rebase across multiple epochs
    /// @param tokenId The veNFT to check
    /// @param epochs Array of epochs to check
    /// @return rewards Array of pending amounts per epoch
    function getPendingMultipleEpochs(uint256 tokenId, uint256[] calldata epochs) external view returns (uint256[] memory rewards);

    /// @notice Get all unclaimed epochs for a veNFT
    /// @param tokenId The veNFT to check
    /// @return epochs Array of epochs with unclaimed rebase
    function getUnclaimedEpochs(uint256 tokenId) external view returns (uint256[] memory epochs);

    /// @notice Calculate total pending rebase for a veNFT across all epochs
    /// @param tokenId The veNFT to check
    /// @return totalPending Total unclaimed rebase amount
    function getTotalPendingRebase(uint256 tokenId) external view returns (uint256 totalPending);

    /// @notice Get rebase distribution information for an epoch
    /// @param epoch The epoch number
    /// @return distribution The rebase distribution info
    function getRebaseDistribution(uint256 epoch) external view returns (RebaseDistribution memory distribution);

    /// @notice Get claim information for a veNFT and epoch
    /// @param tokenId The veNFT ID
    /// @param epoch The epoch number
    /// @return claim The rebase claim info
    function getRebaseClaim(uint256 tokenId, uint256 epoch) external view returns (RebaseClaim memory claim);

    /// @notice Check if veNFT has claimed rebase for an epoch
    /// @param tokenId The veNFT ID
    /// @param epoch The epoch number
    /// @return True if already claimed
    function hasClaimed(uint256 tokenId, uint256 epoch) external view returns (bool);

    /// @notice Get total rebase distributed across all epochs
    /// @return Total WOOD distributed as rebase
    function getTotalRebaseDistributed() external view returns (uint256);

    /// @notice Get total rebase claimed across all epochs
    /// @return Total WOOD claimed as rebase
    function getTotalRebaseClaimed() external view returns (uint256);

    /// @notice Get last claim epoch for a veNFT
    /// @param tokenId The veNFT ID
    /// @return Last epoch where rebase was claimed
    function getLastClaimEpoch(uint256 tokenId) external view returns (uint256);

    /// @notice VotingEscrow contract
    function votingEscrow() external view returns (address);

    /// @notice WOOD token contract
    function wood() external view returns (address);

    /// @notice Minter contract (authorized to distribute rebase)
    function minter() external view returns (address);
}