// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IVoteIncentive — Bribe marketplace for syndicate votes
/// @notice Interface for VoteIncentive contract that manages vote incentives (bribes)
///         for syndicate gauges with on-chain pro-rata distribution.
interface IVoteIncentive {

    // ==================== STRUCTS ====================

    /// @notice Incentive pool for a syndicate in an epoch
    struct IncentivePool {
        address token;              // ERC-20 token address
        uint256 amount;             // Total amount deposited
        uint256 totalClaimed;       // Amount already claimed
        uint256 depositDeadline;    // Deadline for deposits (epoch start)
        bool active;                // Whether pool accepts new deposits
    }

    /// @notice Claim information for a voter
    struct ClaimInfo {
        uint256 amount;             // Amount claimable
        bool claimed;               // Whether already claimed
    }

    // ==================== EVENTS ====================

    event IncentiveDeposited(
        address indexed depositor,
        uint256 indexed syndicateId,
        uint256 indexed epoch,
        address token,
        uint256 amount
    );

    event IncentiveClaimed(
        address indexed voter,
        uint256 indexed syndicateId,
        uint256 indexed epoch,
        address token,
        uint256 amount,
        uint256 votes,
        uint256 totalVotes
    );

    event IncentivePoolCreated(
        uint256 indexed syndicateId,
        uint256 indexed epoch,
        address indexed token,
        uint256 depositDeadline
    );

    // ==================== ERRORS ====================

    error DepositDeadlinePassed();
    error IncentiveNotActive();
    error InvalidAmount();
    error InvalidToken();
    error NoIncentiveToClaim();
    error AlreadyClaimed();
    error InvalidSyndicateId();
    error InvalidEpoch();
    error TransferFailed();

    // ==================== CORE FUNCTIONS ====================

    /// @notice Deposit incentive tokens for a syndicate in an epoch
    /// @param syndicateId The syndicate to incentivize
    /// @param epoch The epoch to incentivize (current or next only)
    /// @param token The ERC-20 token to deposit as incentive
    /// @param amount The amount of tokens to deposit
    function depositIncentive(uint256 syndicateId, uint256 epoch, address token, uint256 amount) external;

    /// @notice Claim earned incentives for a specific syndicate and epoch
    /// @param syndicateId The syndicate voted for
    /// @param epoch The epoch number
    /// @param tokens Array of incentive token addresses to claim
    /// @return amounts Array of amounts claimed per token
    function claimIncentives(uint256 syndicateId, uint256 epoch, address[] calldata tokens) external returns (uint256[] memory amounts);

    /// @notice Claim all available incentives for a voter across multiple syndicates/epochs
    /// @param syndicateIds Array of syndicate IDs
    /// @param epochs Array of epoch numbers
    /// @param tokens Array of token addresses to claim
    /// @return totalAmounts Total amounts claimed per token across all claims
    function claimAllIncentives(
        uint256[] calldata syndicateIds,
        uint256[] calldata epochs,
        address[] calldata tokens
    ) external returns (uint256[] memory totalAmounts);

    // ==================== VIEW FUNCTIONS ====================

    /// @notice Calculate pending incentives for a voter
    /// @param voterAddress The voter address
    /// @param syndicateId The syndicate voted for
    /// @param epoch The epoch number
    /// @param token Incentive token address
    /// @return amount Pending incentive amount
    function getPendingIncentives(
        address voterAddress,
        uint256 syndicateId,
        uint256 epoch,
        address token
    ) external view returns (uint256 amount);

    /// @notice Get all pending incentives for a voter across multiple tokens
    /// @param voterAddress The voter address
    /// @param syndicateId The syndicate voted for
    /// @param epoch The epoch number
    /// @param tokens Array of token addresses
    /// @return amounts Array of pending amounts per token
    function getPendingMultipleTokens(
        address voterAddress,
        uint256 syndicateId,
        uint256 epoch,
        address[] calldata tokens
    ) external view returns (uint256[] memory amounts);

    /// @notice Get incentive pool information
    /// @param syndicateId The syndicate ID
    /// @param epoch The epoch number
    /// @param token The token address
    /// @return pool The incentive pool info
    function getIncentivePool(
        uint256 syndicateId,
        uint256 epoch,
        address token
    ) external view returns (IncentivePool memory pool);

    /// @notice Get all active incentive tokens for a syndicate in an epoch
    /// @param syndicateId The syndicate ID
    /// @param epoch The epoch number
    /// @return tokens Array of token addresses with active incentive pools
    function getActiveIncentiveTokens(uint256 syndicateId, uint256 epoch) external view returns (address[] memory tokens);

    /// @notice Get claim information for a voter
    /// @param voterAddress The voter address
    /// @param syndicateId The syndicate ID
    /// @param epoch The epoch number
    /// @param token The token address
    /// @return info The claim information
    function getClaimInfo(
        address voterAddress,
        uint256 syndicateId,
        uint256 epoch,
        address token
    ) external view returns (ClaimInfo memory info);

    /// @notice Check if voter has claimed for a specific incentive
    /// @param voterAddress The voter address
    /// @param syndicateId The syndicate ID
    /// @param epoch The epoch number
    /// @param token The token address
    /// @return True if already claimed
    function hasClaimed(
        address voterAddress,
        uint256 syndicateId,
        uint256 epoch,
        address token
    ) external view returns (bool);

    /// @notice Get total incentives deposited for a token across all syndicates/epochs
    /// @param token The token address
    /// @return Total amount deposited
    function getTotalIncentivesDeposited(address token) external view returns (uint256);

    /// @notice Get total incentives claimed for a token across all syndicates/epochs
    /// @param token The token address
    /// @return Total amount claimed
    function getTotalIncentivesClaimed(address token) external view returns (uint256);

    /// @notice Voter contract (for vote checkpoints)
    function voter() external view returns (address);

    /// @notice VotingEscrow contract (for NFT ownership verification)
    function votingEscrow() external view returns (address);

    /// @notice Deposit deadline offset (incentives must be deposited before epoch starts)
    function DEPOSIT_DEADLINE_OFFSET() external view returns (uint256);
}