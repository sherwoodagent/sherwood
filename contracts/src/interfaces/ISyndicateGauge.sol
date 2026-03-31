// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ISyndicateGauge — Per-syndicate emission receiver
/// @notice Interface for SyndicateGauge contract that receives WOOD emissions
///         proportional to votes and streams them to vault rewards + LPs.
interface ISyndicateGauge {

    // ==================== STRUCTS ====================

    /// @notice Emission distribution for an epoch
    struct EmissionDistribution {
        uint256 totalReceived;      // Total WOOD received this epoch
        uint256 vaultRewards;       // Amount sent to vault rewards (90-100%)
        uint256 lpRewards;          // Amount sent to LPs (0-10%, weeks 1-12 only)
        uint256 epoch;              // Epoch number
        bool distributed;           // Whether distribution was executed
    }

    // ==================== EVENTS ====================

    event EmissionReceived(uint256 indexed epoch, uint256 amount, address indexed from);

    event EmissionDistributed(
        uint256 indexed epoch,
        uint256 vaultRewards,
        uint256 lpRewards,
        uint256 totalDistributed
    );

    event LPRewardsClaimed(address indexed lp, uint256 amount, uint256 epoch);

    // ==================== ERRORS ====================

    error NotAuthorized();
    error EpochNotReady();
    error DistributionAlreadyExecuted();
    error NoEmissionToDistribute();
    error InvalidEpoch();

    // ==================== CORE FUNCTIONS ====================

    /// @notice Receive WOOD emissions for an epoch
    /// @param epoch The epoch number
    /// @param amount Amount of WOOD to receive
    /// @dev Only callable by Minter contract
    function receiveEmission(uint256 epoch, uint256 amount) external;

    /// @notice Distribute received emissions to vault and LPs
    /// @param epoch The epoch to distribute
    function distributeEmission(uint256 epoch) external;

    /// @notice Claim LP bootstrapping rewards (weeks 1-12 only)
    /// @param epoch The epoch to claim from
    /// @dev Pro-rata based on LP position in Uniswap V3 pool
    function claimLPRewards(uint256 epoch) external;

    // ==================== VIEW FUNCTIONS ====================

    /// @notice Get emission distribution for an epoch
    /// @param epoch The epoch number
    /// @return distribution The emission distribution info
    function getEmissionDistribution(uint256 epoch) external view returns (EmissionDistribution memory distribution);

    /// @notice Calculate LP reward percentage for an epoch
    /// @param epoch The epoch number
    /// @return Percentage of emissions going to LPs (basis points)
    function getLPRewardPercentage(uint256 epoch) external view returns (uint256);

    /// @notice Get pending LP rewards for a liquidity provider
    /// @param lp The LP address
    /// @param epoch The epoch number
    /// @return Pending reward amount
    function getPendingLPRewards(address lp, uint256 epoch) external view returns (uint256);

    /// @notice Get total emissions received across all epochs
    /// @return Total WOOD received by this gauge
    function getTotalEmissionsReceived() external view returns (uint256);

    /// @notice Check if LP bootstrapping is active for current epoch
    /// @return True if current epoch ≤ 12
    function isLPBootstrappingActive() external view returns (bool);

    /// @notice Syndicate ID this gauge represents
    function syndicateId() external view returns (uint256);

    /// @notice Syndicate vault address
    function syndicateVault() external view returns (address);

    /// @notice VaultRewardsDistributor for this syndicate
    function vaultRewardsDistributor() external view returns (address);

    /// @notice Uniswap V3 pool (shareToken/WOOD)
    function uniswapPool() external view returns (address);

    /// @notice Uniswap V3 LP position NFT token ID
    function lpTokenId() external view returns (uint256);

    /// @notice WOOD token contract
    function wood() external view returns (address);

    /// @notice Voter contract
    function voter() external view returns (address);

    /// @notice LP bootstrapping duration (12 epochs)
    function LP_BOOTSTRAP_EPOCHS() external view returns (uint256);
}