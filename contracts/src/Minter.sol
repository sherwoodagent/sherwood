// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IMinter} from "./interfaces/IMinter.sol";
import {IVoter} from "./interfaces/IVoter.sol";
import {IVotingEscrow} from "./interfaces/IVotingEscrow.sol";
import {ISyndicateGauge} from "./interfaces/ISyndicateGauge.sol";
import {IRewardsDistributor} from "./interfaces/IRewardsDistributor.sol";
import {IWoodToken} from "./interfaces/IWoodToken.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Minter — WOOD emission schedule and epoch management
/// @notice Handles 3-phase emission schedule, epoch flipping, rebase calculations,
///         and WOOD Fed voting for emission rate adjustments.
contract Minter is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IWoodToken;
    // ==================== ENUMS ====================

    /// @notice Emission phases
    enum Phase {
        TakeOff, // Epochs 1-8: +3%/week
        Cruise, // Epochs 9-44: -1%/week
        WoodFed // Epochs 45+: Voter-controlled ±0.35%/epoch
    }

    /// @notice WOOD Fed vote options
    enum WoodFedVote {
        Increase, // +0.35% of current rate
        Decrease, // -0.35% of current rate
        Hold // No change
    }

    // ==================== STRUCTS ====================

    /// @notice Emission state for an epoch
    struct EmissionState {
        uint256 totalEmission; // Total WOOD emitted this epoch
        uint256 teamAllocation; // 5% to team/treasury
        uint256 gaugeAllocation; // 95% to gauges
        uint256 rebaseAmount; // veWOOD rebase amount
        Phase phase; // Current emission phase
        bool processed; // Whether epoch was processed
    }

    // ==================== CONSTANTS ====================

    /// @notice Initial emission rate (5M WOOD/week)
    uint256 public constant INITIAL_EMISSION = 5_000_000e18;

    /// @notice Team allocation percentage (5%)
    uint256 public constant TEAM_ALLOCATION_BPS = 500; // 5% in basis points

    /// @notice WOOD Fed rate change per vote (±0.35%)
    uint256 public constant WOOD_FED_RATE_CHANGE = 35; // 0.35% in basis points

    /// @notice Maximum deviation from baseline (±5%)
    uint256 public constant MAX_BASELINE_DEVIATION = 500; // 5% in basis points

    /// @notice Basis points denominator
    uint256 public constant BASIS_POINTS = 10000;

    /// @notice Take-off phase weekly increase (3%)
    uint256 private constant TAKEOFF_INCREASE_BPS = 300; // 3% in basis points

    /// @notice Cruise phase weekly decrease (1%)
    uint256 private constant CRUISE_DECREASE_BPS = 100; // 1% in basis points

    /// @notice Rebase multiplier (0.5)
    uint256 private constant REBASE_MULTIPLIER = 5000; // 50% in basis points

    // ==================== IMMUTABLE ====================

    /// @notice WoodToken contract
    IWoodToken public immutable wood;

    /// @notice Voter contract
    IVoter public immutable voter;

    /// @notice VotingEscrow contract
    IVotingEscrow public immutable votingEscrow;

    /// @notice Team treasury address
    address public immutable teamTreasury;

    /// @notice RewardsDistributor for veWOOD rebase
    address public rewardsDistributor;

    // ==================== STORAGE ====================

    /// @notice Current emission rate (WOOD per epoch)
    uint256 private _currentEmissionRate;

    /// @notice Emission state for each epoch
    /// @dev epoch => EmissionState
    mapping(uint256 => EmissionState) private _emissionStates;

    /// @notice WOOD Fed votes per epoch
    /// @dev epoch => voteType => totalVotingPower
    mapping(uint256 => mapping(WoodFedVote => uint256)) private _woodFedVotes;

    /// @notice Whether a veNFT has voted in WOOD Fed for an epoch
    /// @dev epoch => tokenId => bool
    mapping(uint256 => mapping(uint256 => bool)) private _hasVotedWoodFed;

    /// @notice Circuit breaker state
    bool private _circuitBreakerActive;
    uint256 private _emissionReductionPercent;

    /// @notice Maximum emission rate ceiling (owner-settable)
    uint256 private _maxEmissionRate;

    /// @notice Last processed epoch
    uint256 private _lastProcessedEpoch;

    /// @notice Historical emission rates for baseline calculation
    uint256[] private _emissionHistory;

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

    event MaxEmissionRateChanged(uint256 oldRate, uint256 newRate);

    // ==================== ERRORS ====================

    error EpochNotReady();
    error EpochAlreadyProcessed();
    error NotAuthorized();
    error InvalidVote();
    error VotingNotActive();
    error CircuitBreakerActive();

    // ==================== CONSTRUCTOR ====================

    /// @param _wood WoodToken contract address
    /// @param _voter Voter contract address
    /// @param _votingEscrow VotingEscrow contract address
    /// @param _teamTreasury Team treasury address
    /// @param _owner Contract owner
    constructor(address _wood, address _voter, address _votingEscrow, address _teamTreasury, address _owner)
        Ownable(_owner)
    {
        if (_wood == address(0) || _voter == address(0) || _votingEscrow == address(0) || _teamTreasury == address(0)) {
            revert NotAuthorized();
        }

        wood = IWoodToken(_wood);
        voter = IVoter(_voter);
        votingEscrow = IVotingEscrow(_votingEscrow);
        teamTreasury = _teamTreasury;

        _currentEmissionRate = INITIAL_EMISSION;
        // Initialize max emission rate to a reasonable ceiling (10x initial)
        _maxEmissionRate = INITIAL_EMISSION * 10;
    }

    // ==================== CORE FUNCTIONS ====================

    function flipEpoch() external nonReentrant whenNotPaused {
        uint256 currentEpoch = voter.currentEpoch();

        // Check if epoch is ready to be processed
        if (block.timestamp < voter.getEpochEnd(currentEpoch - 1)) revert EpochNotReady();
        if (_emissionStates[currentEpoch].processed) revert EpochAlreadyProcessed();

        // Calculate emission for this epoch (using current rate, before phase update)
        uint256 totalEmission = calculateEpochEmission();
        uint256 teamAllocation = (totalEmission * TEAM_ALLOCATION_BPS) / BASIS_POINTS;
        uint256 gaugeAllocation = totalEmission - teamAllocation;
        uint256 rebaseAmount = calculateRebase();

        // Record the rate actually used for this epoch's emission (before phase update)
        _emissionHistory.push(_currentEmissionRate);

        // Update emission rate based on phase (takes effect next epoch)
        _updateEmissionRate(currentEpoch);

        // Store emission state
        _emissionStates[currentEpoch] = EmissionState({
            totalEmission: totalEmission,
            teamAllocation: teamAllocation,
            gaugeAllocation: gaugeAllocation,
            rebaseAmount: rebaseAmount,
            phase: getCurrentPhase(),
            processed: true
        });

        // Mint and distribute WOOD tokens
        if (totalEmission > 0) {
            wood.mint(teamTreasury, teamAllocation);

            // Distribute gauge allocation to SyndicateGauges based on vote distribution
            if (gaugeAllocation > 0) {
                wood.mint(address(this), gaugeAllocation);
                _distributeToGauges(currentEpoch, gaugeAllocation);
            }

            // Distribute rebase via RewardsDistributor
            if (rebaseAmount > 0 && rewardsDistributor != address(0)) {
                wood.mint(address(this), rebaseAmount);
                wood.forceApprove(rewardsDistributor, rebaseAmount);
                IRewardsDistributor(rewardsDistributor).distributeRebase(currentEpoch, rebaseAmount);
            }
        }

        _lastProcessedEpoch = currentEpoch;

        emit EpochProcessed(
            currentEpoch, totalEmission, teamAllocation, gaugeAllocation, rebaseAmount, getCurrentPhase()
        );

        // Flip voter epoch
        voter.flipEpoch();
    }

    function voteWoodFed(uint256 tokenId, WoodFedVote vote) external nonReentrant {
        if (getCurrentPhase() != Phase.WoodFed) revert VotingNotActive();
        if (votingEscrow.ownerOf(tokenId) != msg.sender) revert NotAuthorized();

        uint256 currentEpoch = voter.currentEpoch();
        if (_hasVotedWoodFed[currentEpoch][tokenId]) revert InvalidVote();

        // Use historical snapshot to prevent retroactive vote manipulation
        uint256 epochStart = voter.getEpochStart(currentEpoch);
        uint256 votingPower = votingEscrow.balanceOfNFTAt(tokenId, epochStart);
        if (votingPower == 0) revert NotAuthorized();

        _woodFedVotes[currentEpoch][vote] += votingPower;
        _hasVotedWoodFed[currentEpoch][tokenId] = true;

        emit WoodFedVoteCast(msg.sender, tokenId, vote, votingPower);
    }

    function pauseEmissions() external onlyOwner {
        _pause();
    }

    function resumeEmissions() external onlyOwner {
        _unpause();
    }

    /// @notice Owner-only manual circuit breaker. Halves emissions for the
    ///         current and subsequent epochs until cleared.
    /// @dev V1: manual-only. Automated price / lock-ratio triggers require a
    ///      WOOD Chainlink feed which does not yet exist; the protocol
    ///      multisig is responsible for monitoring and pulling this lever.
    function triggerCircuitBreaker() external onlyOwner {
        _circuitBreakerActive = true;
        _emissionReductionPercent = 5000;
        emit CircuitBreakerTriggered(voter.currentEpoch(), _emissionReductionPercent, "Manual trigger");
    }

    // ==================== VIEW FUNCTIONS ====================

    function getCurrentEmissionRate() external view returns (uint256) {
        return _currentEmissionRate;
    }

    function calculateEpochEmission() public view returns (uint256) {
        uint256 baseEmission = _currentEmissionRate;

        // Apply circuit breaker reduction if active
        if (_circuitBreakerActive) {
            baseEmission = (baseEmission * (BASIS_POINTS - _emissionReductionPercent)) / BASIS_POINTS;
        }

        // Apply maximum emission rate ceiling
        if (baseEmission > _maxEmissionRate) {
            baseEmission = _maxEmissionRate;
        }

        return baseEmission;
    }

    function calculateRebase() public view returns (uint256) {
        uint256 weeklyEmissions = calculateEpochEmission();
        uint256 totalSupply = wood.totalSupply();
        uint256 veSupply = votingEscrow.totalLockedAmount();

        if (totalSupply == 0) return 0;

        // rebase = weeklyEmissions × (1 - veSupply/totalSupply)² × 0.5
        uint256 lockRatio = (veSupply * BASIS_POINTS) / totalSupply;
        if (lockRatio >= BASIS_POINTS) return 0;

        uint256 unlockRatio = BASIS_POINTS - lockRatio;
        uint256 unlockRatioSquared = (unlockRatio * unlockRatio) / BASIS_POINTS;

        // Restructure calculation to prevent integer overflow while maintaining precision:
        // Use mulDiv pattern: (weeklyEmissions * unlockRatioSquared) / BASIS_POINTS * REBASE_MULTIPLIER / BASIS_POINTS
        uint256 intermediate = (weeklyEmissions * unlockRatioSquared) / BASIS_POINTS;
        return (intermediate * REBASE_MULTIPLIER) / BASIS_POINTS;
    }

    function getEmissionState(uint256 epoch) external view returns (EmissionState memory state) {
        return _emissionStates[epoch];
    }

    function getCurrentPhase() public view returns (Phase) {
        uint256 currentEpoch = voter.currentEpoch();

        if (currentEpoch <= 8) {
            return Phase.TakeOff;
        } else if (currentEpoch <= 44) {
            return Phase.Cruise;
        } else {
            return Phase.WoodFed;
        }
    }

    function getWoodFedResults(uint256 epoch)
        external
        view
        returns (uint256 increaseVotes, uint256 decreaseVotes, uint256 holdVotes, WoodFedVote winningVote)
    {
        increaseVotes = _woodFedVotes[epoch][WoodFedVote.Increase];
        decreaseVotes = _woodFedVotes[epoch][WoodFedVote.Decrease];
        holdVotes = _woodFedVotes[epoch][WoodFedVote.Hold];

        // Determine winning vote
        if (increaseVotes >= decreaseVotes && increaseVotes >= holdVotes) {
            winningVote = WoodFedVote.Increase;
        } else if (decreaseVotes >= holdVotes) {
            winningVote = WoodFedVote.Decrease;
        } else {
            winningVote = WoodFedVote.Hold;
        }
    }

    function calculateBaseline() public view returns (uint256) {
        if (_emissionHistory.length == 0) return _currentEmissionRate;

        uint256 lookback = _emissionHistory.length > 8 ? 8 : _emissionHistory.length;
        uint256 sum = 0;

        for (uint256 i = 0; i < lookback; i++) {
            sum += _emissionHistory[_emissionHistory.length - 1 - i];
        }

        return sum / lookback;
    }

    function isEmissionsPaused() external view returns (bool) {
        return paused();
    }

    function getCircuitBreakerStatus() external view returns (bool active, uint256 reductionPercent) {
        return (_circuitBreakerActive, _emissionReductionPercent);
    }

    // ==================== INTERNAL FUNCTIONS ====================

    /// @dev Update emission rate based on current phase
    function _updateEmissionRate(uint256 epoch) internal {
        Phase currentPhase = getCurrentPhase();
        uint256 oldRate = _currentEmissionRate;

        if (currentPhase == Phase.TakeOff) {
            // +3% per week
            _currentEmissionRate = (_currentEmissionRate * (BASIS_POINTS + TAKEOFF_INCREASE_BPS)) / BASIS_POINTS;
        } else if (currentPhase == Phase.Cruise) {
            // -1% per week
            _currentEmissionRate = (_currentEmissionRate * (BASIS_POINTS - CRUISE_DECREASE_BPS)) / BASIS_POINTS;
        } else if (currentPhase == Phase.WoodFed) {
            // Voter-controlled
            WoodFedVote winningVote = _getWoodFedWinner(epoch);

            if (winningVote == WoodFedVote.Increase) {
                _currentEmissionRate = (_currentEmissionRate * (BASIS_POINTS + WOOD_FED_RATE_CHANGE)) / BASIS_POINTS;
            } else if (winningVote == WoodFedVote.Decrease) {
                _currentEmissionRate = (_currentEmissionRate * (BASIS_POINTS - WOOD_FED_RATE_CHANGE)) / BASIS_POINTS;
            }
            // Hold: no change

            // Apply baseline constraint
            uint256 baseline = calculateBaseline();
            uint256 maxRate = (baseline * (BASIS_POINTS + MAX_BASELINE_DEVIATION)) / BASIS_POINTS;
            uint256 minRate = (baseline * (BASIS_POINTS - MAX_BASELINE_DEVIATION)) / BASIS_POINTS;

            if (_currentEmissionRate > maxRate) {
                _currentEmissionRate = maxRate;
            } else if (_currentEmissionRate < minRate) {
                _currentEmissionRate = minRate;
            }

            emit EmissionRateChanged(epoch, oldRate, _currentEmissionRate, winningVote);
        }
    }

    /// @dev Get winning WOOD Fed vote for an epoch
    function _getWoodFedWinner(uint256 epoch) internal view returns (WoodFedVote) {
        uint256 increaseVotes = _woodFedVotes[epoch][WoodFedVote.Increase];
        uint256 decreaseVotes = _woodFedVotes[epoch][WoodFedVote.Decrease];
        uint256 holdVotes = _woodFedVotes[epoch][WoodFedVote.Hold];

        if (increaseVotes >= decreaseVotes && increaseVotes >= holdVotes) {
            return WoodFedVote.Increase;
        } else if (decreaseVotes >= holdVotes) {
            return WoodFedVote.Decrease;
        } else {
            return WoodFedVote.Hold;
        }
    }

    // ==================== ADMIN FUNCTIONS ====================

    /// @notice Disable circuit breaker (only owner)
    function disableCircuitBreaker() external onlyOwner {
        _circuitBreakerActive = false;
        _emissionReductionPercent = 0;
    }

    /// @notice Set emission reduction percentage (only owner)
    function setEmissionReduction(uint256 reductionPercent) external onlyOwner {
        require(reductionPercent <= BASIS_POINTS, "Invalid reduction");
        _emissionReductionPercent = reductionPercent;
        _circuitBreakerActive = reductionPercent > 0;
    }

    /// @notice Set maximum emission rate ceiling (only owner)
    function setMaxEmissionRate(uint256 maxRate) external onlyOwner {
        require(maxRate > 0, "Max rate must be positive");
        uint256 oldRate = _maxEmissionRate;
        _maxEmissionRate = maxRate;
        emit MaxEmissionRateChanged(oldRate, maxRate);
    }

    /// @notice Get maximum emission rate ceiling
    function getMaxEmissionRate() external view returns (uint256) {
        return _maxEmissionRate;
    }

    /// @notice Set the RewardsDistributor address (only owner)
    function setRewardsDistributor(address _rewardsDistributor) external onlyOwner {
        rewardsDistributor = _rewardsDistributor;
    }

    // ==================== INTERNAL ====================

    /// @dev Distribute gauge allocation to SyndicateGauges proportional to votes
    function _distributeToGauges(uint256 epoch, uint256 gaugeAllocation) internal {
        // First epoch has no previous votes — send to treasury
        if (epoch <= 1) {
            wood.safeTransfer(teamTreasury, gaugeAllocation);
            return;
        }

        (uint256[] memory syndicateIds, uint256[] memory allocations) = voter.getVoteDistribution(epoch - 1);

        // Calculate total allocation weight
        uint256 totalWeight = 0;
        for (uint256 i = 0; i < allocations.length; i++) {
            totalWeight += allocations[i];
        }

        if (totalWeight == 0) {
            // No votes — send gauge allocation to treasury as fallback
            wood.safeTransfer(teamTreasury, gaugeAllocation);
            return;
        }

        // Distribute proportionally to each gauge
        uint256 distributed = 0;
        for (uint256 i = 0; i < syndicateIds.length; i++) {
            if (allocations[i] == 0) continue;

            IVoter.GaugeInfo memory gaugeInfo = voter.getGaugeInfo(syndicateIds[i]);
            if (gaugeInfo.gauge == address(0) || !gaugeInfo.active) continue;

            uint256 gaugeShare = (gaugeAllocation * allocations[i]) / totalWeight;
            if (gaugeShare == 0) continue;

            // Approve and send to gauge
            wood.forceApprove(gaugeInfo.gauge, gaugeShare);
            ISyndicateGauge(gaugeInfo.gauge).receiveEmission(epoch, gaugeShare);
            distributed += gaugeShare;
        }

        // Send any dust to treasury
        uint256 dust = gaugeAllocation - distributed;
        if (dust > 0) {
            wood.safeTransfer(teamTreasury, dust);
        }
    }
}
