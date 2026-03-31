// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IMinter — WOOD emission schedule and epoch management
/// @notice Interface for the Minter contract that handles 3-phase emission schedule,
///         epoch flipping, rebase calculations, and WOOD Fed voting.
interface IMinter {

    // ==================== ENUMS ====================

    /// @notice Emission phases
    enum Phase {
        TakeOff,    // Epochs 1-8: +3%/week
        Cruise,     // Epochs 9-44: -1%/week
        WoodFed     // Epochs 45+: Voter-controlled ±0.35%/epoch
    }

    /// @notice WOOD Fed vote options
    enum WoodFedVote {
        Increase,   // +0.35% of current rate
        Decrease,   // -0.35% of current rate
        Hold        // No change
    }

    // ==================== STRUCTS ====================

    /// @notice Emission state for an epoch
    struct EmissionState {
        uint256 totalEmission;      // Total WOOD emitted this epoch
        uint256 teamAllocation;     // 5% to team/treasury
        uint256 gaugeAllocation;    // 95% to gauges
        uint256 rebaseAmount;       // veWOOD rebase amount
        Phase phase;                // Current emission phase
        bool processed;             // Whether epoch was processed
    }

    // ==================== EVENTS ====================

    event EpochProcessed(
        uint256 indexed epoch,
        uint256 totalEmission,
        uint256 teamAllocation,
        uint256 gaugeAllocation,
        uint256 rebaseAmount,
        Phase phase
    );

    event WoodFedVoteCast(address indexed voter, uint256 indexed tokenId, WoodFedVote vote, uint256 power);

    event EmissionRateChanged(uint256 indexed epoch, uint256 oldRate, uint256 newRate, WoodFedVote winningVote);

    event CircuitBreakerTriggered(uint256 indexed epoch, uint256 reductionPercent, string reason);

    // ==================== ERRORS ====================

    error EpochNotReady();
    error EpochAlreadyProcessed();
    error NotAuthorized();
    error InvalidVote();
    error VotingNotActive();
    error CircuitBreakerActive();

    // ==================== CORE FUNCTIONS ====================

    /// @notice Process the current epoch - mint emissions and distribute
    /// @dev Can be called by anyone after epoch ends
    function flipEpoch() external;

    /// @notice Vote on emission rate change (WOOD Fed phase only)
    /// @param tokenId The veNFT to vote with
    /// @param vote The vote choice (Increase, Decrease, Hold)
    function voteWoodFed(uint256 tokenId, WoodFedVote vote) external;

    /// @notice Emergency pause emissions (circuit breaker)
    /// @dev Only callable by pause guardian
    function pauseEmissions() external;

    /// @notice Resume emissions after pause
    /// @dev Only callable by pause guardian
    function resumeEmissions() external;

    /// @notice Trigger circuit breaker based on price/lock rate
    /// @dev Automatically reduces emissions based on WOOD price decline
    function triggerCircuitBreaker() external;

    // ==================== VIEW FUNCTIONS ====================

    /// @notice Get current epoch emission rate
    /// @return Current weekly emission amount in WOOD tokens
    function getCurrentEmissionRate() external view returns (uint256);

    /// @notice Calculate emission amount for current epoch
    /// @return Total emission amount for the epoch
    function calculateEpochEmission() external view returns (uint256);

    /// @notice Calculate rebase amount for current epoch
    /// @return Rebase amount for veWOOD holders
    function calculateRebase() external view returns (uint256);

    /// @notice Get emission state for an epoch
    /// @param epoch The epoch number
    /// @return state The emission state
    function getEmissionState(uint256 epoch) external view returns (EmissionState memory state);

    /// @notice Get current emission phase
    /// @return Current phase (TakeOff, Cruise, WoodFed)
    function getCurrentPhase() external view returns (Phase);

    /// @notice Get WOOD Fed voting results for an epoch
    /// @param epoch The epoch number
    /// @return increaseVotes Total votes for Increase
    /// @return decreaseVotes Total votes for Decrease
    /// @return holdVotes Total votes for Hold
    /// @return winningVote The winning vote option
    function getWoodFedResults(uint256 epoch) external view returns (
        uint256 increaseVotes,
        uint256 decreaseVotes,
        uint256 holdVotes,
        WoodFedVote winningVote
    );

    /// @notice Calculate 8-epoch rolling baseline
    /// @return Rolling average of last 8 epochs' emission rates
    function calculateBaseline() external view returns (uint256);

    /// @notice Check if emissions are paused
    /// @return True if emissions are paused
    function isEmissionsPaused() external view returns (bool);

    /// @notice Get circuit breaker status
    /// @return active Whether circuit breaker is active
    /// @return reductionPercent Current emission reduction percentage
    function getCircuitBreakerStatus() external view returns (bool active, uint256 reductionPercent);

    /// @notice Initial emission rate (5M WOOD/week)
    function INITIAL_EMISSION() external view returns (uint256);

    /// @notice Team allocation percentage (5%)
    function TEAM_ALLOCATION_BPS() external view returns (uint256);

    /// @notice WOOD Fed rate change per vote (±0.35%)
    function WOOD_FED_RATE_CHANGE() external view returns (uint256);

    /// @notice Maximum deviation from baseline (±5%)
    function MAX_BASELINE_DEVIATION() external view returns (uint256);

    /// @notice WoodToken contract
    function wood() external view returns (address);

    /// @notice Voter contract
    function voter() external view returns (address);

    /// @notice VotingEscrow contract
    function votingEscrow() external view returns (address);

    /// @notice Team treasury address
    function teamTreasury() external view returns (address);
}