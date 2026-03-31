// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IVaultRewardsDistributor — On-chain pro-rata WOOD claims
/// @notice Interface for VaultRewardsDistributor that handles pro-rata WOOD
///         reward distribution to vault depositors using ERC20Votes checkpoints.
interface IVaultRewardsDistributor {

    // ==================== STRUCTS ====================

    /// @notice Reward pool information for an epoch
    struct RewardPool {
        uint256 totalRewards;       // Total WOOD rewards for this epoch
        uint256 totalClaimed;       // Amount already claimed
        uint256 epochStart;         // Epoch start timestamp (for checkpoint)
        uint256 expiryTimestamp;    // When rewards expire (52 weeks later)
        bool expired;               // Whether rewards have expired
    }

    // ==================== EVENTS ====================

    event RewardsDeposited(uint256 indexed epoch, uint256 amount, address indexed from);

    event RewardsClaimed(
        address indexed depositor,
        uint256 indexed epoch,
        uint256 amount,
        uint256 shares,
        uint256 totalShares
    );

    event RewardsExpired(uint256 indexed epoch, uint256 amount, address indexed treasury);

    // ==================== ERRORS ====================

    error NotAuthorized();
    error InvalidEpoch();
    error NoRewardsToClaim();
    error RewardsExpiredError();
    error AlreadyClaimed();
    error InvalidAmount();

    // ==================== CORE FUNCTIONS ====================

    /// @notice Deposit WOOD rewards for an epoch
    /// @param epoch The epoch number
    /// @param amount Amount of WOOD rewards to deposit
    /// @dev Only callable by SyndicateGauge
    function depositRewards(uint256 epoch, uint256 amount) external;

    /// @notice Claim WOOD rewards for a specific epoch
    /// @param epoch The epoch to claim rewards from
    /// @return amount Amount of WOOD claimed
    function claimRewards(uint256 epoch) external returns (uint256 amount);

    /// @notice Claim rewards from multiple epochs at once
    /// @param epochs Array of epochs to claim from
    /// @return totalAmount Total WOOD claimed across all epochs
    function claimMultipleEpochs(uint256[] calldata epochs) external returns (uint256 totalAmount);

    /// @notice Return expired rewards to treasury
    /// @param epoch The expired epoch to process
    /// @dev Can be called by anyone after rewards expire
    function returnExpiredRewards(uint256 epoch) external;

    // ==================== VIEW FUNCTIONS ====================

    /// @notice Calculate pending rewards for a depositor in an epoch
    /// @param depositor The depositor address
    /// @param epoch The epoch number
    /// @return reward Pending reward amount
    function getPendingRewards(address depositor, uint256 epoch) external view returns (uint256 reward);

    /// @notice Calculate pending rewards across multiple epochs
    /// @param depositor The depositor address
    /// @param epochs Array of epochs to check
    /// @return rewards Array of pending reward amounts
    function getPendingMultipleEpochs(address depositor, uint256[] calldata epochs) external view returns (uint256[] memory rewards);

    /// @notice Get all claimable epochs for a depositor
    /// @param depositor The depositor address
    /// @return epochs Array of epochs with claimable rewards
    function getClaimableEpochs(address depositor) external view returns (uint256[] memory epochs);

    /// @notice Get reward pool information for an epoch
    /// @param epoch The epoch number
    /// @return pool The reward pool info
    function getRewardPool(uint256 epoch) external view returns (RewardPool memory pool);

    /// @notice Check if depositor has claimed rewards for an epoch
    /// @param depositor The depositor address
    /// @param epoch The epoch number
    /// @return True if already claimed
    function hasClaimed(address depositor, uint256 epoch) external view returns (bool);

    /// @notice Get total rewards deposited across all epochs
    /// @return Total WOOD rewards deposited
    function getTotalRewardsDeposited() external view returns (uint256);

    /// @notice Get total rewards claimed across all epochs
    /// @return Total WOOD rewards claimed
    function getTotalRewardsClaimed() external view returns (uint256);

    /// @notice Syndicate vault contract (ERC20Votes)
    function syndicateVault() external view returns (address);

    /// @notice WOOD token contract
    function wood() external view returns (address);

    /// @notice Protocol treasury (receives expired rewards)
    function treasury() external view returns (address);

    /// @notice Reward claim window (52 epochs = 1 year)
    function CLAIM_WINDOW() external view returns (uint256);
}