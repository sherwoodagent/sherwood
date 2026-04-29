// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISyndicateGauge} from "./interfaces/ISyndicateGauge.sol";
import {IVoter} from "./interfaces/IVoter.sol";
import {IVaultRewardsDistributor} from "./interfaces/IVaultRewardsDistributor.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title SyndicateGauge — Per-syndicate emission receiver
/// @notice Receives WOOD emissions proportional to votes and distributes them
///         to vault rewards and LP rewards (weeks 1-12 only).
contract SyndicateGauge is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==================== STRUCTS ====================

    /// @notice Emission distribution for an epoch
    struct EmissionDistribution {
        uint256 totalReceived; // Total WOOD received this epoch
        uint256 vaultRewards; // Amount sent to vault rewards (90-100%)
        uint256 lpRewards; // Amount sent to LPs (0-10%, weeks 1-12 only)
        uint256 epoch; // Epoch number
        bool distributed; // Whether distribution was executed
    }

    // ==================== CONSTANTS ====================

    /// @notice LP bootstrapping duration (12 epochs)
    uint256 public constant LP_BOOTSTRAP_EPOCHS = 12;

    /// @notice Basis points denominator
    uint256 private constant BASIS_POINTS = 10000;

    // ==================== IMMUTABLE ====================

    /// @notice Syndicate ID this gauge represents
    uint256 public immutable syndicateId;

    /// @notice Syndicate vault address
    address public immutable syndicateVault;

    /// @notice VaultRewardsDistributor for this syndicate
    address public immutable vaultRewardsDistributor;

    /// @notice Uniswap V3 pool (shareToken/WOOD)
    address public immutable uniswapPool;

    /// @notice Uniswap V3 LP position NFT token ID
    uint256 public immutable lpTokenId;

    /// @notice WOOD token contract
    IERC20 public immutable wood;

    /// @notice Voter contract
    IVoter public immutable voter;

    /// @notice Minter contract (only address that can call receiveEmission)
    address public immutable minter;

    // ==================== STORAGE ====================

    /// @notice Emission distributions per epoch
    /// @dev epoch => EmissionDistribution
    mapping(uint256 => EmissionDistribution) private _distributions;

    /// @notice LP rewards claimed per epoch per LP
    /// @dev epoch => lp => claimed amount
    mapping(uint256 => mapping(address => uint256)) private _lpClaims;

    /// @notice Total emissions received across all epochs
    uint256 private _totalEmissionsReceived;

    // ==================== EVENTS ====================

    event EmissionReceived(uint256 indexed epoch, uint256 amount, address indexed from);

    event EmissionDistributed(uint256 indexed epoch, uint256 vaultRewards, uint256 lpRewards, uint256 totalDistributed);

    event LPRewardsClaimed(address indexed lp, uint256 amount, uint256 epoch);

    // ==================== ERRORS ====================

    error NotAuthorized();
    error EpochNotReady();
    error DistributionAlreadyExecuted();
    error NoEmissionToDistribute();
    error InvalidEpoch();

    // ==================== MODIFIERS ====================

    /// @notice Restrict function access to the Minter contract only
    modifier onlyMinter() {
        if (msg.sender != minter) revert NotAuthorized();
        _;
    }

    // ==================== CONSTRUCTOR ====================

    /// @param _syndicateId The syndicate ID from SyndicateFactory
    /// @param _syndicateVault The syndicate vault address
    /// @param _vaultRewardsDistributor The VaultRewardsDistributor contract
    /// @param _uniswapPool The Uniswap V3 pool address for shareToken/WOOD
    /// @param _lpTokenId The Uniswap V3 LP position NFT token ID
    /// @param _wood WOOD token contract address
    /// @param _voter Voter contract address
    /// @param _minter Minter contract address (only address that can call receiveEmission)
    /// @param _owner Contract owner
    constructor(
        uint256 _syndicateId,
        address _syndicateVault,
        address _vaultRewardsDistributor,
        address _uniswapPool,
        uint256 _lpTokenId,
        address _wood,
        address _voter,
        address _minter,
        address _owner
    ) Ownable(_owner) {
        syndicateId = _syndicateId;
        syndicateVault = _syndicateVault;
        vaultRewardsDistributor = _vaultRewardsDistributor;
        uniswapPool = _uniswapPool;
        lpTokenId = _lpTokenId;
        wood = IERC20(_wood);
        voter = IVoter(_voter);
        minter = _minter;
    }

    // ==================== CORE FUNCTIONS ====================

    function receiveEmission(uint256 epoch, uint256 amount) external onlyMinter {
        if (amount == 0) revert NoEmissionToDistribute();

        EmissionDistribution storage distribution = _distributions[epoch];
        if (distribution.distributed) revert DistributionAlreadyExecuted();

        // Calculate LP reward percentage based on epoch
        uint256 lpPercentage = getLPRewardPercentage(epoch);
        uint256 lpRewards = (amount * lpPercentage) / BASIS_POINTS;
        uint256 vaultRewards = amount - lpRewards;

        distribution.totalReceived = amount;
        distribution.vaultRewards = vaultRewards;
        distribution.lpRewards = lpRewards;
        distribution.epoch = epoch;

        _totalEmissionsReceived += amount;

        // Transfer WOOD from sender
        wood.safeTransferFrom(msg.sender, address(this), amount);

        emit EmissionReceived(epoch, amount, msg.sender);
    }

    function distributeEmission(uint256 epoch) external nonReentrant {
        EmissionDistribution storage distribution = _distributions[epoch];
        if (distribution.totalReceived == 0) revert NoEmissionToDistribute();
        if (distribution.distributed) revert DistributionAlreadyExecuted();

        uint256 vaultRewards = distribution.vaultRewards;
        uint256 lpRewards = distribution.lpRewards;

        // Mark as distributed
        distribution.distributed = true;

        // Send vault rewards to VaultRewardsDistributor
        if (vaultRewards > 0) {
            wood.forceApprove(vaultRewardsDistributor, vaultRewards);
            IVaultRewardsDistributor(vaultRewardsDistributor).depositRewards(epoch, vaultRewards);
        }

        // LP rewards stay in this contract for claiming

        emit EmissionDistributed(epoch, vaultRewards, lpRewards, distribution.totalReceived);
    }

    function claimLPRewards(uint256 epoch) external nonReentrant {
        if (!isLPBootstrappingActive()) revert InvalidEpoch();

        EmissionDistribution storage distribution = _distributions[epoch];
        if (!distribution.distributed) revert DistributionAlreadyExecuted();
        if (distribution.lpRewards == 0) revert NoEmissionToDistribute();

        // Check if already claimed
        if (_lpClaims[epoch][msg.sender] > 0) revert DistributionAlreadyExecuted();

        // Calculate LP's share based on their Uniswap V3 position
        uint256 lpReward = _calculateLPReward(msg.sender, epoch, distribution.lpRewards);
        if (lpReward == 0) revert NoEmissionToDistribute();

        _lpClaims[epoch][msg.sender] = lpReward;

        // Transfer WOOD to LP
        wood.safeTransfer(msg.sender, lpReward);

        emit LPRewardsClaimed(msg.sender, lpReward, epoch);
    }

    // ==================== VIEW FUNCTIONS ====================

    function getEmissionDistribution(uint256 epoch) external view returns (EmissionDistribution memory distribution) {
        return _distributions[epoch];
    }

    function getLPRewardPercentage(uint256) public pure returns (uint256) {
        return 0;
    }

    /// @notice Owner-only rescue path for `lpRewards` slices that accrued
    ///         under the prior bootstrap schedule (epochs ≤ 12) but are
    ///         unclaimable while LP integration is unimplemented.
    function rescueStuckLPRewards(uint256 epoch, address recipient) external onlyOwner {
        if (recipient == address(0)) revert NotAuthorized();
        EmissionDistribution storage distribution = _distributions[epoch];
        uint256 amount = distribution.lpRewards;
        if (amount == 0) revert NoEmissionToDistribute();
        distribution.lpRewards = 0;
        wood.safeTransfer(recipient, amount);
        emit LPRewardsClaimed(recipient, amount, epoch);
    }

    function getPendingLPRewards(address lp, uint256 epoch) external view returns (uint256) {
        if (_lpClaims[epoch][lp] > 0) return 0; // Already claimed

        EmissionDistribution storage distribution = _distributions[epoch];
        if (!distribution.distributed || distribution.lpRewards == 0) return 0;

        return _calculateLPReward(lp, epoch, distribution.lpRewards);
    }

    function getTotalEmissionsReceived() external view returns (uint256) {
        return _totalEmissionsReceived;
    }

    function isLPBootstrappingActive() public view returns (bool) {
        uint256 currentEpoch = voter.currentEpoch();
        return currentEpoch <= LP_BOOTSTRAP_EPOCHS;
    }

    // ==================== INTERNAL FUNCTIONS ====================

    /// @dev V1: LP rewards are not implemented. `getLPRewardPercentage`
    ///      returns 0 so future emissions never accrue to this slice; legacy
    ///      lp slices are recoverable via `rescueStuckLPRewards`.
    function _calculateLPReward(address, uint256, uint256) internal pure returns (uint256) {
        return 0;
    }
}
