// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVaultRewardsDistributor} from "./interfaces/IVaultRewardsDistributor.sol";
import {ISyndicateVault} from "./interfaces/ISyndicateVault.sol";
import {IVoter} from "./interfaces/IVoter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC5805} from "@openzeppelin/contracts/interfaces/IERC5805.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title VaultRewardsDistributor — On-chain pro-rata WOOD claims
/// @notice Distributes WOOD rewards to vault depositors using ERC20Votes checkpoints
///         for fully trustless and immediate claim processing.
contract VaultRewardsDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==================== STRUCTS ====================

    /// @notice Reward pool information for an epoch
    struct RewardPool {
        uint256 totalRewards;       // Total WOOD rewards for this epoch
        uint256 totalClaimed;       // Amount already claimed
        uint256 epochStart;         // Epoch start timestamp (for checkpoint)
        uint256 expiryTimestamp;    // When rewards expire (52 weeks later)
        bool expired;               // Whether rewards have expired
    }

    // ==================== CONSTANTS ====================

    /// @notice Reward claim window (52 epochs = 1 year)
    uint256 public constant CLAIM_WINDOW = 52;

    // ==================== IMMUTABLE ====================

    /// @notice Syndicate vault contract (ERC20Votes)
    IERC5805 public immutable syndicateVault;

    /// @notice WOOD token contract
    IERC20 public immutable wood;

    /// @notice Protocol treasury (receives expired rewards)
    address public immutable treasury;

    /// @notice Voter contract (for epoch timing)
    IVoter public immutable voter;

    // ==================== STORAGE ====================

    /// @notice Authorized depositor (typically SyndicateGauge) that can call depositRewards
    address public authorizedDepositor;

    /// @notice Reward pools per epoch
    /// @dev epoch => RewardPool
    mapping(uint256 => RewardPool) private _rewardPools;

    /// @notice Claims tracking per depositor per epoch
    /// @dev depositor => epoch => claimed
    mapping(address => mapping(uint256 => bool)) private _claims;

    /// @notice Total rewards deposited across all epochs
    uint256 private _totalRewardsDeposited;

    /// @notice Total rewards claimed across all epochs
    uint256 private _totalRewardsClaimed;

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

    event AuthorizedDepositorChanged(address indexed oldDepositor, address indexed newDepositor);

    // ==================== ERRORS ====================

    error NotAuthorized();
    error InvalidEpoch();
    error NoRewardsToClaim();
    error RewardsExpiredError();
    error AlreadyClaimed();
    error InvalidAmount();

    // ==================== CONSTRUCTOR ====================

    /// @param _syndicateVault Syndicate vault contract address (must be ERC20Votes)
    /// @param _wood WOOD token contract address
    /// @param _treasury Protocol treasury address
    /// @param _voter Voter contract address
    /// @param _owner Contract owner
    constructor(
        address _syndicateVault,
        address _wood,
        address _treasury,
        address _voter,
        address _owner
    ) Ownable(_owner) {
        if (_syndicateVault == address(0) || _wood == address(0) || _treasury == address(0) || _voter == address(0)) {
            revert InvalidAmount();
        }

        syndicateVault = IERC5805(_syndicateVault);
        wood = IERC20(_wood);
        treasury = _treasury;
        voter = IVoter(_voter);
    }

    // ==================== CORE FUNCTIONS ====================

    function depositRewards(uint256 epoch, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();

        // Only allow authorized depositor (SyndicateGauge) or owner to call this
        if (msg.sender != authorizedDepositor && msg.sender != owner()) revert NotAuthorized();

        RewardPool storage pool = _rewardPools[epoch];
        if (pool.totalRewards > 0) revert InvalidEpoch(); // Already deposited

        uint256 epochStart = voter.getEpochStart(epoch);
        if (epochStart == 0) revert InvalidEpoch();

        pool.totalRewards = amount;
        pool.epochStart = epochStart;
        pool.expiryTimestamp = epochStart + (CLAIM_WINDOW * 7 days); // 52 epochs later
        pool.expired = false;

        _totalRewardsDeposited += amount;

        // Transfer WOOD from sender
        wood.safeTransferFrom(msg.sender, address(this), amount);

        emit RewardsDeposited(epoch, amount, msg.sender);
    }

    
    function claimRewards(uint256 epoch) external nonReentrant returns (uint256 amount) {
        if (_claims[msg.sender][epoch]) revert AlreadyClaimed();

        RewardPool storage pool = _rewardPools[epoch];
        if (pool.totalRewards == 0) revert NoRewardsToClaim();
        if (pool.expired || block.timestamp > pool.expiryTimestamp) revert RewardsExpiredError();

        // Calculate pro-rata share using ERC20Votes checkpoints
        uint256 depositorShares = syndicateVault.getPastVotes(msg.sender, pool.epochStart);
        uint256 totalShares = syndicateVault.getPastTotalSupply(pool.epochStart);

        if (depositorShares == 0 || totalShares == 0) revert NoRewardsToClaim();

        amount = (pool.totalRewards * depositorShares) / totalShares;
        if (amount == 0) revert NoRewardsToClaim();

        // Mark as claimed
        _claims[msg.sender][epoch] = true;
        pool.totalClaimed += amount;
        _totalRewardsClaimed += amount;

        // Transfer WOOD to depositor
        wood.safeTransfer(msg.sender, amount);

        emit RewardsClaimed(msg.sender, epoch, amount, depositorShares, totalShares);
    }

    
    function claimMultipleEpochs(uint256[] calldata epochs) external nonReentrant returns (uint256 totalAmount) {
        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];

            if (_claims[msg.sender][epoch]) continue; // Skip if already claimed

            RewardPool storage pool = _rewardPools[epoch];
            if (pool.totalRewards == 0 || pool.expired || block.timestamp > pool.expiryTimestamp) {
                continue; // Skip invalid or expired epochs
            }

            // Calculate pro-rata share
            uint256 depositorShares = syndicateVault.getPastVotes(msg.sender, pool.epochStart);
            uint256 totalShares = syndicateVault.getPastTotalSupply(pool.epochStart);

            if (depositorShares == 0 || totalShares == 0) continue;

            uint256 amount = (pool.totalRewards * depositorShares) / totalShares;
            if (amount == 0) continue;

            // Mark as claimed
            _claims[msg.sender][epoch] = true;
            pool.totalClaimed += amount;
            _totalRewardsClaimed += amount;
            totalAmount += amount;

            emit RewardsClaimed(msg.sender, epoch, amount, depositorShares, totalShares);
        }

        if (totalAmount > 0) {
            wood.safeTransfer(msg.sender, totalAmount);
        }
    }

    function returnExpiredRewards(uint256 epoch) external nonReentrant {
        RewardPool storage pool = _rewardPools[epoch];
        if (pool.totalRewards == 0) revert InvalidEpoch();
        if (pool.expired) revert InvalidEpoch(); // Already processed
        if (block.timestamp <= pool.expiryTimestamp) revert RewardsExpiredError(); // Not expired yet

        uint256 expiredAmount = pool.totalRewards - pool.totalClaimed;
        if (expiredAmount == 0) return; // Nothing to return

        pool.expired = true;

        // Return expired rewards to treasury
        wood.safeTransfer(treasury, expiredAmount);

        emit RewardsExpired(epoch, expiredAmount, treasury);
    }


    function returnMultipleExpiredRewards(uint256[] calldata epochs) external nonReentrant {
        uint256 totalExpiredAmount = 0;

        for (uint256 i = 0; i < epochs.length; i++) {
            uint256 epoch = epochs[i];
            RewardPool storage pool = _rewardPools[epoch];

            // Skip if invalid, already processed, or not expired yet
            if (pool.totalRewards == 0 || pool.expired || block.timestamp <= pool.expiryTimestamp) {
                continue;
            }

            uint256 expiredAmount = pool.totalRewards - pool.totalClaimed;
            if (expiredAmount > 0) {
                pool.expired = true;
                totalExpiredAmount += expiredAmount;

                emit RewardsExpired(epoch, expiredAmount, treasury);
            }
        }

        // Transfer total expired rewards to treasury if any
        if (totalExpiredAmount > 0) {
            wood.safeTransfer(treasury, totalExpiredAmount);
        }
    }

    // ==================== VIEW FUNCTIONS ====================

    
    function getPendingRewards(address depositor, uint256 epoch) external view returns (uint256 reward) {
        if (_claims[depositor][epoch]) return 0; // Already claimed

        RewardPool storage pool = _rewardPools[epoch];
        if (pool.totalRewards == 0 || pool.expired || block.timestamp > pool.expiryTimestamp) {
            return 0;
        }

        uint256 depositorShares = syndicateVault.getPastVotes(depositor, pool.epochStart);
        uint256 totalShares = syndicateVault.getPastTotalSupply(pool.epochStart);

        if (depositorShares == 0 || totalShares == 0) return 0;

        return (pool.totalRewards * depositorShares) / totalShares;
    }

    
    function getPendingMultipleEpochs(address depositor, uint256[] calldata epochs) external view returns (uint256[] memory rewards) {
        rewards = new uint256[](epochs.length);

        for (uint256 i = 0; i < epochs.length; i++) {
            rewards[i] = this.getPendingRewards(depositor, epochs[i]);
        }
    }

    function getClaimableEpochs(address depositor) external view returns (uint256[] memory epochs) {
        uint256 currentEpoch = voter.currentEpoch();

        // Cap search to maximum 100 epochs back from current to prevent gas issues
        uint256 startEpoch = currentEpoch > 100 ? currentEpoch - 100 : 1;

        return this.getClaimableEpochs(depositor, startEpoch, currentEpoch);
    }


    function getClaimableEpochs(
        address depositor,
        uint256 fromEpoch,
        uint256 toEpoch
    ) external view returns (uint256[] memory epochs) {
        require(fromEpoch <= toEpoch, "Invalid epoch range");
        require(toEpoch <= voter.currentEpoch(), "ToEpoch exceeds current epoch");

        uint256 maxEpochs = toEpoch - fromEpoch + 1;
        uint256[] memory tempEpochs = new uint256[](maxEpochs);
        uint256 count = 0;

        for (uint256 epoch = fromEpoch; epoch <= toEpoch; epoch++) {
            if (!_claims[depositor][epoch] && this.getPendingRewards(depositor, epoch) > 0) {
                tempEpochs[count] = epoch;
                count++;
            }
        }

        // Resize array to actual count
        epochs = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            epochs[i] = tempEpochs[i];
        }
    }

    
    function getRewardPool(uint256 epoch) external view returns (RewardPool memory pool) {
        return _rewardPools[epoch];
    }

    
    function hasClaimed(address depositor, uint256 epoch) external view returns (bool) {
        return _claims[depositor][epoch];
    }

    
    function getTotalRewardsDeposited() external view returns (uint256) {
        return _totalRewardsDeposited;
    }


    function getTotalRewardsClaimed() external view returns (uint256) {
        return _totalRewardsClaimed;
    }

    // ==================== ADMIN FUNCTIONS ====================

    /// @notice Set the authorized depositor address (only owner)
    /// @param _authorizedDepositor Address that can call depositRewards (typically SyndicateGauge)
    function setAuthorizedDepositor(address _authorizedDepositor) external onlyOwner {
        address oldDepositor = authorizedDepositor;
        authorizedDepositor = _authorizedDepositor;
        emit AuthorizedDepositorChanged(oldDepositor, _authorizedDepositor);
    }
}