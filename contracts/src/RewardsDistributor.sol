// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IRewardsDistributor} from "./interfaces/IRewardsDistributor.sol";
import {IVotingEscrow} from "./interfaces/IVotingEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title RewardsDistributor — veWOOD rebase (anti-dilution) distribution
/// @notice Distributes rebase rewards to veWOOD holders proportional to their
///         locked amounts to provide anti-dilution protection.
contract RewardsDistributor is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

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

    // ==================== IMMUTABLE ====================

    /// @notice VotingEscrow contract
    IVotingEscrow public immutable votingEscrow;

    /// @notice WOOD token contract
    IERC20 public immutable wood;

    /// @notice Minter contract (authorized to distribute rebase)
    address public immutable minter;

    // ==================== STORAGE ====================

    /// @notice Rebase distributions per epoch
    /// @dev epoch => RebaseDistribution
    mapping(uint256 => RebaseDistribution) private _rebaseDistributions;

    /// @notice Rebase claims per veNFT per epoch
    /// @dev tokenId => epoch => RebaseClaim
    mapping(uint256 => mapping(uint256 => RebaseClaim)) private _rebaseClaims;

    /// @notice Last claim epoch per veNFT
    /// @dev tokenId => epoch
    mapping(uint256 => uint256) private _lastClaimEpoch;

    /// @notice Total rebase distributed across all epochs
    uint256 private _totalRebaseDistributed;

    /// @notice Total rebase claimed across all epochs
    uint256 private _totalRebaseClaimed;

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

    // ==================== CONSTRUCTOR ====================

    /// @param _votingEscrow VotingEscrow contract address
    /// @param _wood WOOD token contract address
    /// @param _minter Minter contract address (authorized to call distributeRebase)
    /// @param _owner Contract owner
    constructor(
        address _votingEscrow,
        address _wood,
        address _minter,
        address _owner
    ) Ownable(_owner) {
        if (_votingEscrow == address(0) || _wood == address(0) || _minter == address(0)) {
            revert NotAuthorized();
        }

        votingEscrow = IVotingEscrow(_votingEscrow);
        wood = IERC20(_wood);
        minter = _minter;
    }

    // ==================== CORE FUNCTIONS ====================

    
    function distributeRebase(uint256 epoch, uint256 rebaseAmount) external {
        if (msg.sender != minter) revert NotAuthorized();
        if (rebaseAmount == 0) revert InvalidEpoch();

        RebaseDistribution storage distribution = _rebaseDistributions[epoch];
        if (distribution.processed) revert DistributionNotReady(); // Already processed

        // Calculate total locked amount at distribution time
        // Note: This is a simplified approach. In production, you'd want to use
        // the total locked amount at the epoch boundary for consistency
        uint256 totalLocked = _calculateTotalLocked();

        distribution.totalRebase = rebaseAmount;
        distribution.totalLocked = totalLocked;
        distribution.distributionTime = block.timestamp;
        distribution.processed = true;

        _totalRebaseDistributed += rebaseAmount;

        // Transfer WOOD from Minter
        wood.safeTransferFrom(msg.sender, address(this), rebaseAmount);

        emit RebaseDistributed(epoch, rebaseAmount, totalLocked);
    }

    
    function claimRebase(uint256 tokenId, uint256 epoch) external nonReentrant returns (uint256 amount) {
        if (votingEscrow.ownerOf(tokenId) != msg.sender) revert TokenNotOwned();

        amount = _claimSingleEpoch(tokenId, epoch);
        if (amount > 0) {
            wood.safeTransfer(msg.sender, amount);
        }
    }

    
    function claimMultipleEpochs(uint256 tokenId, uint256[] calldata epochs) external nonReentrant returns (uint256 totalAmount) {
        if (votingEscrow.ownerOf(tokenId) != msg.sender) revert TokenNotOwned();

        for (uint256 i = 0; i < epochs.length; i++) {
            totalAmount += _claimSingleEpoch(tokenId, epochs[i]);
        }

        if (totalAmount > 0) {
            wood.safeTransfer(msg.sender, totalAmount);
        }
    }

    
    function claimAll(uint256 tokenId) external nonReentrant returns (uint256 totalAmount) {
        if (votingEscrow.ownerOf(tokenId) != msg.sender) revert TokenNotOwned();

        uint256 lastClaim = _lastClaimEpoch[tokenId];
        uint256[] memory epochs = _getUnclaimedEpochsInternal(tokenId, lastClaim);

        for (uint256 i = 0; i < epochs.length; i++) {
            totalAmount += _claimSingleEpoch(tokenId, epochs[i]);
        }

        if (totalAmount > 0) {
            wood.safeTransfer(msg.sender, totalAmount);
        }
    }

    // ==================== VIEW FUNCTIONS ====================

    
    function getPendingRebase(uint256 tokenId, uint256 epoch) external view returns (uint256 reward) {
        RebaseClaim storage claim = _rebaseClaims[tokenId][epoch];
        if (claim.claimed) return 0;

        return _calculateRebaseAmount(tokenId, epoch);
    }

    
    function getPendingMultipleEpochs(uint256 tokenId, uint256[] calldata epochs) external view returns (uint256[] memory rewards) {
        rewards = new uint256[](epochs.length);

        for (uint256 i = 0; i < epochs.length; i++) {
            rewards[i] = this.getPendingRebase(tokenId, epochs[i]);
        }
    }

    
    function getUnclaimedEpochs(uint256 tokenId) external view returns (uint256[] memory epochs) {
        uint256 lastClaim = _lastClaimEpoch[tokenId];
        return _getUnclaimedEpochsInternal(tokenId, lastClaim);
    }

    
    function getTotalPendingRebase(uint256 tokenId) external view returns (uint256 totalPending) {
        uint256[] memory epochs = this.getUnclaimedEpochs(tokenId);

        for (uint256 i = 0; i < epochs.length; i++) {
            totalPending += this.getPendingRebase(tokenId, epochs[i]);
        }
    }

    
    function getRebaseDistribution(uint256 epoch) external view returns (RebaseDistribution memory distribution) {
        return _rebaseDistributions[epoch];
    }

    
    function getRebaseClaim(uint256 tokenId, uint256 epoch) external view returns (RebaseClaim memory claim) {
        return _rebaseClaims[tokenId][epoch];
    }

    
    function hasClaimed(uint256 tokenId, uint256 epoch) external view returns (bool) {
        return _rebaseClaims[tokenId][epoch].claimed;
    }

    
    function getTotalRebaseDistributed() external view returns (uint256) {
        return _totalRebaseDistributed;
    }

    
    function getTotalRebaseClaimed() external view returns (uint256) {
        return _totalRebaseClaimed;
    }

    
    function getLastClaimEpoch(uint256 tokenId) external view returns (uint256) {
        return _lastClaimEpoch[tokenId];
    }

    // ==================== INTERNAL FUNCTIONS ====================

    /// @dev Claim rebase for a single epoch
    function _claimSingleEpoch(uint256 tokenId, uint256 epoch) internal returns (uint256 amount) {
        RebaseClaim storage claim = _rebaseClaims[tokenId][epoch];
        if (claim.claimed) return 0; // Already claimed

        amount = _calculateRebaseAmount(tokenId, epoch);
        if (amount == 0) return 0;

        // Mark as claimed
        claim.amount = amount;
        claim.claimed = true;
        _totalRebaseClaimed += amount;

        // Update last claim epoch
        if (epoch > _lastClaimEpoch[tokenId]) {
            _lastClaimEpoch[tokenId] = epoch;
        }

        // Get lock info for event
        IVotingEscrow.LockInfo memory lockInfo = votingEscrow.getLock(tokenId);

        emit RebaseClaimed(
            msg.sender,
            tokenId,
            epoch,
            amount,
            lockInfo.amount,
            _rebaseDistributions[epoch].totalLocked
        );
    }

    /// @dev Calculate rebase amount for a veNFT in an epoch
    function _calculateRebaseAmount(uint256 tokenId, uint256 epoch) internal view returns (uint256) {
        RebaseDistribution storage distribution = _rebaseDistributions[epoch];
        if (!distribution.processed || distribution.totalLocked == 0) return 0;

        // Get lock info at distribution time
        IVotingEscrow.LockInfo memory lockInfo = votingEscrow.getLock(tokenId);
        if (lockInfo.amount == 0) return 0;

        // Pro-rata share based on locked amount
        return (distribution.totalRebase * lockInfo.amount) / distribution.totalLocked;
    }

    /// @dev Calculate total locked WOOD across all veNFTs using VotingEscrow's totalSupply
    function _calculateTotalLocked() internal view returns (uint256 totalLocked) {
        totalLocked = votingEscrow.totalSupply();
        if (totalLocked == 0) totalLocked = 1; // Avoid division by zero
    }

    /// @dev Get unclaimed epochs for a tokenId since last claim
    function _getUnclaimedEpochsInternal(uint256 tokenId, uint256 lastClaim) internal view returns (uint256[] memory epochs) {
        // This is a simplified implementation
        // In production, you'd want to limit the search range and use more efficient data structures

        uint256 maxEpoch = 100; // Arbitrary limit for demonstration
        uint256[] memory tempEpochs = new uint256[](maxEpoch);
        uint256 count = 0;

        for (uint256 epoch = lastClaim + 1; epoch <= maxEpoch; epoch++) {
            if (_rebaseDistributions[epoch].processed && !_rebaseClaims[tokenId][epoch].claimed) {
                if (_calculateRebaseAmount(tokenId, epoch) > 0) {
                    tempEpochs[count] = epoch;
                    count++;
                }
            }
        }

        // Resize array to actual count
        epochs = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            epochs[i] = tempEpochs[i];
        }
    }
}