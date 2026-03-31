// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @title IVotingEscrow — Lock WOOD → veWOOD NFT with voting power
/// @notice Interface for the VotingEscrow contract that allows users to lock WOOD tokens
///         to receive veWOOD NFTs with time-weighted voting power.
interface IVotingEscrow is IERC721 {

    // ==================== STRUCTS ====================

    /// @notice Lock information for a veNFT
    struct LockInfo {
        uint256 amount;         // Amount of WOOD locked
        uint256 end;            // Lock end timestamp
        bool autoMaxLock;       // If true, treated as 1-year lock with no decay
    }

    // ==================== EVENTS ====================

    event Deposit(
        address indexed provider,
        uint256 indexed tokenId,
        uint256 value,
        uint256 locktime,
        uint256 timestamp
    );

    event Withdraw(address indexed provider, uint256 indexed tokenId, uint256 value, uint256 timestamp);

    event Supply(uint256 prevSupply, uint256 supply);

    event AutoMaxLockToggled(uint256 indexed tokenId, bool autoMaxLock);

    // ==================== ERRORS ====================

    error InsufficientLockDuration();
    error LockExpired();
    error NotOwner();
    error LockNotExpired();
    error InvalidAmount();
    error InsufficientBalance();
    error TokenNotExists();

    // ==================== CORE FUNCTIONS ====================

    /// @notice Create a new lock for `msg.sender` and return the new tokenId
    /// @param value Amount of WOOD to lock
    /// @param unlockTime Timestamp when the lock expires (must be ≥ 4 weeks from now)
    /// @param autoMaxLock If true, lock is treated as 1-year with no decay
    /// @return tokenId The newly minted veNFT token ID
    function createLock(uint256 value, uint256 unlockTime, bool autoMaxLock) external returns (uint256 tokenId);

    /// @notice Increase the amount of WOOD locked in an existing veNFT
    /// @param tokenId The veNFT to add to
    /// @param value Additional WOOD amount to lock
    function increaseAmount(uint256 tokenId, uint256 value) external;

    /// @notice Extend the unlock time of an existing veNFT
    /// @param tokenId The veNFT to extend
    /// @param unlockTime New unlock timestamp (must be later than current)
    function increaseUnlockTime(uint256 tokenId, uint256 unlockTime) external;

    /// @notice Withdraw all WOOD from an expired lock and burn the veNFT
    /// @param tokenId The expired veNFT to withdraw from
    function withdraw(uint256 tokenId) external;

    /// @notice Toggle auto-max-lock for a veNFT
    /// @param tokenId The veNFT to toggle
    function toggleAutoMaxLock(uint256 tokenId) external;

    // ==================== VIEW FUNCTIONS ====================

    /// @notice Get the voting power of a veNFT at current time
    /// @param tokenId The veNFT to query
    /// @return Voting power (scaled same as locked amount)
    function balanceOfNFT(uint256 tokenId) external view returns (uint256);

    /// @notice Get the voting power of a veNFT at a specific timestamp
    /// @param tokenId The veNFT to query
    /// @param timestamp The timestamp to query at
    /// @return Voting power at the given timestamp
    function balanceOfNFTAt(uint256 tokenId, uint256 timestamp) external view returns (uint256);

    /// @notice Get the total voting power of all veNFTs at current time
    /// @return Total voting power
    function totalSupply() external view returns (uint256);

    /// @notice Get the total voting power at a specific timestamp
    /// @param timestamp The timestamp to query at
    /// @return Total voting power at the given timestamp
    function totalSupplyAt(uint256 timestamp) external view returns (uint256);

    /// @notice Get lock information for a veNFT
    /// @param tokenId The veNFT to query
    /// @return lock The lock information
    function getLock(uint256 tokenId) external view returns (LockInfo memory lock);

    /// @notice Get all veNFT token IDs owned by an address
    /// @param owner The address to query
    /// @return tokenIds Array of owned token IDs
    function getTokenIds(address owner) external view returns (uint256[] memory tokenIds);

    /// @notice Minimum lock duration (4 weeks)
    function MIN_LOCK_DURATION() external view returns (uint256);

    /// @notice Maximum lock duration (1 year)
    function MAX_LOCK_DURATION() external view returns (uint256);

    /// @notice WOOD token address
    function wood() external view returns (address);
}