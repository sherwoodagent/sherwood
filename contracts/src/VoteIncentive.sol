// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVoteIncentive} from "./interfaces/IVoteIncentive.sol";
import {IVoter} from "./interfaces/IVoter.sol";
import {IVotingEscrow} from "./interfaces/IVotingEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title VoteIncentive — Bribe marketplace for syndicate votes
/// @notice Allows anyone to deposit ERC-20 tokens as incentives to attract
///         veWOOD votes to specific syndicates, with pro-rata distribution.
contract VoteIncentive is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

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

    // ==================== CONSTANTS ====================

    /// @notice Deposit deadline offset (incentives must be deposited before epoch starts)
    uint256 public constant DEPOSIT_DEADLINE_OFFSET = 0; // Deposit during previous epoch

    // ==================== IMMUTABLE ====================

    /// @notice Voter contract (for vote checkpoints)
    IVoter public immutable voter;

    /// @notice VotingEscrow contract (for NFT ownership verification)
    IVotingEscrow public immutable votingEscrow;

    // ==================== STORAGE ====================

    /// @notice Incentive pools per syndicate per epoch per token
    /// @dev syndicateId => epoch => token => IncentivePool
    mapping(uint256 => mapping(uint256 => mapping(address => IncentivePool))) private _incentivePools;

    /// @notice Active incentive tokens per syndicate per epoch
    /// @dev syndicateId => epoch => EnumerableSet of token addresses
    mapping(uint256 => mapping(uint256 => EnumerableSet.AddressSet)) private _activeTokens;

    /// @notice Claim tracking per voter per syndicate per epoch per token
    /// @dev voter => syndicateId => epoch => token => ClaimInfo
    mapping(address => mapping(uint256 => mapping(uint256 => mapping(address => ClaimInfo)))) private _claimInfo;

    /// @notice Total incentives deposited per token
    /// @dev token => total amount deposited
    mapping(address => uint256) private _totalDeposited;

    /// @notice Total incentives claimed per token
    /// @dev token => total amount claimed
    mapping(address => uint256) private _totalClaimed;

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

    // ==================== CONSTRUCTOR ====================

    /// @param _voter Voter contract address
    /// @param _votingEscrow VotingEscrow contract address
    /// @param _owner Contract owner
    constructor(
        address _voter,
        address _votingEscrow,
        address _owner
    ) Ownable(_owner) {
        if (_voter == address(0) || _votingEscrow == address(0)) revert InvalidToken();

        voter = IVoter(_voter);
        votingEscrow = IVotingEscrow(_votingEscrow);
    }

    // ==================== CORE FUNCTIONS ====================

    
    function depositIncentive(uint256 syndicateId, uint256 epoch, address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (token == address(0)) revert InvalidToken();

        uint256 currentEpoch = voter.currentEpoch();

        // Can only deposit for current or next epoch
        if (epoch < currentEpoch || epoch > currentEpoch + 1) revert InvalidEpoch();

        // Check deposit deadline - must deposit before target epoch starts
        uint256 epochStart = voter.getEpochStart(epoch);
        if (block.timestamp >= epochStart) revert DepositDeadlinePassed();

        // Check if syndicate exists and is valid
        IVoter.GaugeInfo memory gaugeInfo = voter.getGaugeInfo(syndicateId);
        if (!gaugeInfo.active) revert InvalidSyndicateId();

        // Get or create incentive pool
        IncentivePool storage pool = _incentivePools[syndicateId][epoch][token];
        if (!pool.active) {
            pool.token = token;
            pool.depositDeadline = epochStart;
            pool.active = true;
            _activeTokens[syndicateId][epoch].add(token);

            emit IncentivePoolCreated(syndicateId, epoch, token, epochStart);
        }

        // Update pool
        pool.amount += amount;
        _totalDeposited[token] += amount;

        // Transfer tokens from depositor
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        emit IncentiveDeposited(msg.sender, syndicateId, epoch, token, amount);
    }

    
    function claimIncentives(uint256 syndicateId, uint256 epoch, address[] calldata tokens) external nonReentrant returns (uint256[] memory amounts) {
        amounts = new uint256[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            amounts[i] = _claimSingleIncentive(syndicateId, epoch, tokens[i]);
        }
    }

    
    function claimAllIncentives(
        uint256[] calldata syndicateIds,
        uint256[] calldata epochs,
        address[] calldata tokens
    ) external nonReentrant returns (uint256[] memory totalAmounts) {
        totalAmounts = new uint256[](tokens.length);

        for (uint256 i = 0; i < syndicateIds.length; i++) {
            for (uint256 j = 0; j < epochs.length; j++) {
                for (uint256 k = 0; k < tokens.length; k++) {
                    uint256 claimed = _claimSingleIncentive(syndicateIds[i], epochs[j], tokens[k]);
                    totalAmounts[k] += claimed;
                }
            }
        }
    }

    // ==================== VIEW FUNCTIONS ====================

    
    function getPendingIncentives(
        address voterAddress,
        uint256 syndicateId,
        uint256 epoch,
        address token
    ) external view returns (uint256 amount) {
        ClaimInfo storage claimInfo = _claimInfo[voterAddress][syndicateId][epoch][token];
        if (claimInfo.claimed) return 0;

        return _calculateIncentiveAmount(voterAddress, syndicateId, epoch, token);
    }

    
    function getPendingMultipleTokens(
        address voterAddress,
        uint256 syndicateId,
        uint256 epoch,
        address[] calldata tokens
    ) external view returns (uint256[] memory amounts) {
        amounts = new uint256[](tokens.length);

        for (uint256 i = 0; i < tokens.length; i++) {
            amounts[i] = this.getPendingIncentives(voterAddress, syndicateId, epoch, tokens[i]);
        }
    }

    
    function getIncentivePool(
        uint256 syndicateId,
        uint256 epoch,
        address token
    ) external view returns (IncentivePool memory pool) {
        return _incentivePools[syndicateId][epoch][token];
    }

    
    function getActiveIncentiveTokens(uint256 syndicateId, uint256 epoch) external view returns (address[] memory tokens) {
        return _activeTokens[syndicateId][epoch].values();
    }

    
    function getClaimInfo(
        address voterAddress,
        uint256 syndicateId,
        uint256 epoch,
        address token
    ) external view returns (ClaimInfo memory info) {
        return _claimInfo[voterAddress][syndicateId][epoch][token];
    }

    
    function hasClaimed(
        address voterAddress,
        uint256 syndicateId,
        uint256 epoch,
        address token
    ) external view returns (bool) {
        return _claimInfo[voterAddress][syndicateId][epoch][token].claimed;
    }

    
    function getTotalIncentivesDeposited(address token) external view returns (uint256) {
        return _totalDeposited[token];
    }

    
    function getTotalIncentivesClaimed(address token) external view returns (uint256) {
        return _totalClaimed[token];
    }

    // ==================== INTERNAL FUNCTIONS ====================

    /// @dev Claim incentive for a single syndicate/epoch/token
    function _claimSingleIncentive(uint256 syndicateId, uint256 epoch, address token) internal returns (uint256 amount) {
        ClaimInfo storage claimInfo = _claimInfo[msg.sender][syndicateId][epoch][token];
        if (claimInfo.claimed) return 0; // Already claimed

        // Calculate claimable amount
        amount = _calculateIncentiveAmount(msg.sender, syndicateId, epoch, token);
        if (amount == 0) return 0;

        // Get pool reference for validation
        IncentivePool storage pool = _incentivePools[syndicateId][epoch][token];

        // Prevent over-claiming: cap amount at available pool balance
        if (pool.totalClaimed + amount > pool.amount) {
            amount = pool.amount - pool.totalClaimed;
        }
        if (amount == 0) return 0; // Nothing left to claim

        // Mark as claimed
        claimInfo.amount = amount;
        claimInfo.claimed = true;

        // Update pool and global tracking
        pool.totalClaimed += amount;
        _totalClaimed[token] += amount;

        // Transfer tokens to claimer
        IERC20(token).safeTransfer(msg.sender, amount);

        // Get vote info for event
        IVoter.VoteAllocation memory allocation = voter.getVoteAllocation(_getVoterTokenId(msg.sender), epoch);
        uint256 voterVotes = 0;
        for (uint256 i = 0; i < allocation.syndicateIds.length; i++) {
            if (allocation.syndicateIds[i] == syndicateId) {
                uint256 totalVotingPower = votingEscrow.balanceOfNFTAt(_getVoterTokenId(msg.sender), voter.getEpochStart(epoch));
                voterVotes = (totalVotingPower * allocation.weights[i]) / 10000;
                break;
            }
        }

        uint256 totalVotes = voter.getSyndicateVotes(syndicateId, epoch);

        emit IncentiveClaimed(msg.sender, syndicateId, epoch, token, amount, voterVotes, totalVotes);
    }

    /// @dev Calculate incentive amount for a voter
    function _calculateIncentiveAmount(address voterAddress, uint256 syndicateId, uint256 epoch, address token) internal view returns (uint256) {
        IncentivePool storage pool = _incentivePools[syndicateId][epoch][token];
        if (pool.amount == 0 || !pool.active) return 0;

        // Get voter's vote allocation for this syndicate in this epoch
        uint256 tokenId = _getVoterTokenId(voterAddress);
        if (tokenId == 0) return 0; // Voter doesn't own a veNFT

        IVoter.VoteAllocation memory allocation = voter.getVoteAllocation(tokenId, epoch);

        // Find votes for this syndicate
        uint256 voterVotes = 0;
        for (uint256 i = 0; i < allocation.syndicateIds.length; i++) {
            if (allocation.syndicateIds[i] == syndicateId) {
                uint256 totalVotingPower = votingEscrow.balanceOfNFTAt(tokenId, voter.getEpochStart(epoch));
                voterVotes = (totalVotingPower * allocation.weights[i]) / 10000;
                break;
            }
        }

        if (voterVotes == 0) return 0;

        // Calculate pro-rata share
        uint256 totalSyndicateVotes = voter.getSyndicateVotes(syndicateId, epoch);
        if (totalSyndicateVotes == 0) return 0;

        return (pool.amount * voterVotes) / totalSyndicateVotes;
    }

    /// @dev Get the first veNFT token ID owned by an address
    /// @dev Simplified - in production, might want to allow voters to specify which tokenId to use
    function _getVoterTokenId(address voterAddress) internal view returns (uint256) {
        uint256[] memory tokenIds = votingEscrow.getTokenIds(voterAddress);
        return tokenIds.length > 0 ? tokenIds[0] : 0;
    }
}