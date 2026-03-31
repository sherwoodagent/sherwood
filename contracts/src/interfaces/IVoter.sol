// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IVoter — Epoch voting for syndicate gauges
/// @notice Interface for the Voter contract that manages 7-day epoch voting
///         for syndicate gauge emissions allocation.
interface IVoter {

    // ==================== STRUCTS ====================

    /// @notice Vote allocation for a veNFT in an epoch
    struct VoteAllocation {
        uint256[] syndicateIds;     // Syndicates voted for
        uint256[] weights;          // Vote weights (basis points, must sum to 10000)
    }

    /// @notice Gauge information for a syndicate
    struct GaugeInfo {
        address gauge;              // SyndicateGauge contract address
        bool active;                // Whether gauge is active for voting
    }

    // ==================== EVENTS ====================

    event Voted(
        address indexed voter,
        uint256 indexed tokenId,
        uint256 indexed epoch,
        uint256[] syndicateIds,
        uint256[] weights,
        uint256 power
    );

    event GaugeCreated(uint256 indexed syndicateId, address indexed gauge, address pool, uint256 nftTokenId);

    event GaugeActivated(uint256 indexed syndicateId, address indexed gauge);

    event GaugeDeactivated(uint256 indexed syndicateId, address indexed gauge);

    event EpochFlipped(uint256 indexed newEpoch, uint256 timestamp);

    // ==================== ERRORS ====================

    error NotAuthorized();
    error InvalidWeights();
    error GaugeNotExists();
    error GaugeAlreadyExists();
    error VotingNotActive();
    error InvalidSyndicateId();
    error QuorumNotMet();
    error WeightsSumInvalid();

    // ==================== CORE FUNCTIONS ====================

    /// @notice Vote for syndicates with a veNFT
    /// @param tokenId The veNFT to vote with
    /// @param syndicateIds Array of syndicate IDs to vote for
    /// @param weights Array of vote weights (basis points, must sum to 10000)
    function vote(uint256 tokenId, uint256[] calldata syndicateIds, uint256[] calldata weights) external;

    /// @notice Reset votes for a veNFT in the current epoch
    /// @param tokenId The veNFT to reset votes for
    function reset(uint256 tokenId) external;

    /// @notice Flip to the next epoch (callable by anyone after epoch ends)
    function flipEpoch() external;

    /// @notice Create a gauge for a syndicate
    /// @param syndicateId The syndicate ID from SyndicateFactory
    /// @param pool The Uniswap V3 pool address for shareToken/WOOD
    /// @param nftTokenId The Uniswap V3 LP position NFT token ID
    function createGauge(uint256 syndicateId, address pool, uint256 nftTokenId) external;

    /// @notice Activate/deactivate a gauge
    /// @param syndicateId The syndicate ID
    /// @param active Whether to activate or deactivate
    function setGaugeActive(uint256 syndicateId, bool active) external;

    // ==================== VIEW FUNCTIONS ====================

    /// @notice Get current epoch number
    /// @return Current epoch (starts from 1)
    function currentEpoch() external view returns (uint256);

    /// @notice Get epoch start timestamp
    /// @param epoch The epoch number
    /// @return Timestamp when epoch started (Thursday 00:00 UTC)
    function getEpochStart(uint256 epoch) external view returns (uint256);

    /// @notice Get epoch end timestamp
    /// @param epoch The epoch number
    /// @return Timestamp when epoch ends (Wednesday 23:59 UTC)
    function getEpochEnd(uint256 epoch) external view returns (uint256);

    /// @notice Check if voting is active for current epoch
    /// @return True if current time is within an epoch period
    function isVotingActive() external view returns (bool);

    /// @notice Get vote allocation for a veNFT in an epoch
    /// @param tokenId The veNFT to query
    /// @param epoch The epoch number (0 for current epoch)
    /// @return allocation The vote allocation
    function getVoteAllocation(uint256 tokenId, uint256 epoch) external view returns (VoteAllocation memory allocation);

    /// @notice Get total votes for a syndicate in an epoch
    /// @param syndicateId The syndicate ID
    /// @param epoch The epoch number (0 for current epoch)
    /// @return Total voting power allocated to syndicate
    function getSyndicateVotes(uint256 syndicateId, uint256 epoch) external view returns (uint256);

    /// @notice Get total votes cast in an epoch
    /// @param epoch The epoch number (0 for current epoch)
    /// @return Total voting power that participated
    function getTotalVotes(uint256 epoch) external view returns (uint256);

    /// @notice Check if quorum was met for an epoch
    /// @param epoch The epoch number
    /// @return True if at least 10% of total veWOOD supply voted
    function isQuorumMet(uint256 epoch) external view returns (bool);

    /// @notice Get gauge information for a syndicate
    /// @param syndicateId The syndicate ID
    /// @return info The gauge information
    function getGaugeInfo(uint256 syndicateId) external view returns (GaugeInfo memory info);

    /// @notice Get all active syndicate IDs with gauges
    /// @return Array of active syndicate IDs
    function getActiveSyndicates() external view returns (uint256[] memory);

    /// @notice Calculate vote distribution for an epoch with 25% cap
    /// @param epoch The epoch number
    /// @return syndicateIds Array of syndicate IDs
    /// @return allocations Array of vote percentages (basis points)
    function getVoteDistribution(uint256 epoch) external view returns (uint256[] memory syndicateIds, uint256[] memory allocations);

    /// @notice Minimum quorum threshold (10% of total veWOOD supply)
    function QUORUM_THRESHOLD() external view returns (uint256);

    /// @notice Maximum votes per syndicate (25% of total votes)
    function MAX_SYNDICATE_SHARE() external view returns (uint256);

    /// @notice Epoch duration (7 days)
    function EPOCH_DURATION() external view returns (uint256);

    /// @notice VotingEscrow contract address
    function votingEscrow() external view returns (address);

    /// @notice SyndicateFactory contract address
    function syndicateFactory() external view returns (address);
}