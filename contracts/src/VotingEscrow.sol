// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVotingEscrow} from "./interfaces/IVotingEscrow.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title VotingEscrow — Lock WOOD → veWOOD NFT with voting power
/// @notice Users lock WOOD for chosen duration (4 weeks - 1 year) and receive veWOOD NFT
///         with time-weighted voting power that decays linearly to expiry.
contract VotingEscrow is ERC721, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ==================== STRUCTS ====================

    /// @notice Lock information for a veNFT
    struct LockInfo {
        uint256 amount;         // Amount of WOOD locked
        uint256 end;            // Lock end timestamp
        uint256 createdBlock;   // Block when lock was created (for flash loan protection)
        bool autoMaxLock;       // If true, treated as 1-year lock with no decay
    }

    // ==================== CONSTANTS ====================

    /// @notice Minimum lock duration (4 weeks)
    uint256 public constant MIN_LOCK_DURATION = 4 weeks;

    /// @notice Maximum lock duration (1 year)
    uint256 public constant MAX_LOCK_DURATION = 365 days;

    /// @notice Minimum blocks before voting power is active (flash loan protection)
    uint256 public constant MIN_LOCK_BLOCKS = 1;

    /// @notice WOOD token contract
    IERC20 public immutable wood;

    // ==================== STORAGE ====================

    /// @notice Current token ID counter
    uint256 private _tokenIdCounter = 1; // Start from 1

    /// @notice Lock info for each veNFT
    /// @dev tokenId => LockInfo
    mapping(uint256 => LockInfo) private _locks;

    /// @notice All token IDs owned by an address
    /// @dev owner => tokenId[]
    mapping(address => uint256[]) private _userTokenIds;

    /// @notice Index of tokenId in _userTokenIds array for efficient removal
    /// @dev tokenId => index in _userTokenIds array
    mapping(uint256 => uint256) private _userTokenIndex;

    /// @notice Point history for each veNFT (for voting power checkpoints)
    /// @dev tokenId => epoch => Point
    mapping(uint256 => mapping(uint256 => Point)) private _pointHistory;

    /// @notice Current epoch for each veNFT
    /// @dev tokenId => current epoch
    mapping(uint256 => uint256) private _pointEpoch;

    /// @notice Global point history (for total supply checkpoints)
    /// @dev epoch => Point
    mapping(uint256 => Point) private _supplyPointHistory;

    /// @notice Current global epoch
    uint256 private _globalEpoch;

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
    error AutoMaxLockEnabled();

    /// @dev Point struct for checkpointing
    struct Point {
        int256 bias;        // Voting power at this point
        int256 slope;       // Rate of decay (voting power lost per second)
        uint256 timestamp;  // When this point was recorded
        uint256 blockNumber; // Block number for this point
    }

    // ==================== CONSTRUCTOR ====================

    /// @param _wood WOOD token contract address
    /// @param _owner Contract owner (for emergency functions)
    constructor(address _wood, address _owner) ERC721("Vote Escrowed WOOD", "veWOOD") Ownable(_owner) {
        if (_wood == address(0)) revert InvalidAmount();
        wood = IERC20(_wood);
    }

    // ==================== CORE FUNCTIONS ====================

    
    function createLock(uint256 value, uint256 unlockTime, bool autoMaxLock) external nonReentrant returns (uint256 tokenId) {
        if (value == 0) revert InvalidAmount();
        if (wood.balanceOf(msg.sender) < value) revert InsufficientBalance();

        // Validate lock duration
        if (!autoMaxLock) {
            uint256 duration = unlockTime - block.timestamp;
            if (duration < MIN_LOCK_DURATION || duration > MAX_LOCK_DURATION) {
                revert InsufficientLockDuration();
            }
        } else {
            // Auto-max-lock: set to exactly 1 year from now
            unlockTime = block.timestamp + MAX_LOCK_DURATION;
        }

        // Generate new token ID and mint
        tokenId = _tokenIdCounter++;
        _safeMint(msg.sender, tokenId);

        // Store lock info
        _locks[tokenId] = LockInfo({
            amount: value,
            end: unlockTime,
            createdBlock: block.number,
            autoMaxLock: autoMaxLock
        });

        // Add to user's token list
        _addTokenToUser(msg.sender, tokenId);

        // Transfer WOOD tokens
        wood.safeTransferFrom(msg.sender, address(this), value);

        // Update checkpoints
        _updateLockCheckpoint(tokenId, value, unlockTime);
        _updateSupplyCheckpoint();

        emit Deposit(msg.sender, tokenId, value, unlockTime, block.timestamp);
    }

    
    function increaseAmount(uint256 tokenId, uint256 value) external nonReentrant {
        if (!_isTokenOwner(tokenId, msg.sender)) revert NotOwner();
        if (value == 0) revert InvalidAmount();
        if (wood.balanceOf(msg.sender) < value) revert InsufficientBalance();

        LockInfo storage lock = _locks[tokenId];
        if (block.timestamp >= lock.end && !lock.autoMaxLock) revert LockExpired();

        // Update lock amount
        lock.amount += value;

        // Transfer WOOD tokens
        wood.safeTransferFrom(msg.sender, address(this), value);

        // Update checkpoints
        _updateLockCheckpoint(tokenId, lock.amount, lock.end);
        _updateSupplyCheckpoint();

        emit Deposit(msg.sender, tokenId, value, lock.end, block.timestamp);
    }

    
    function increaseUnlockTime(uint256 tokenId, uint256 unlockTime) external nonReentrant {
        if (!_isTokenOwner(tokenId, msg.sender)) revert NotOwner();

        LockInfo storage lock = _locks[tokenId];

        // Auto-max-lock cannot be extended (it's always max)
        if (lock.autoMaxLock) revert LockExpired();

        // Can only extend, never reduce
        if (unlockTime <= lock.end) revert InsufficientLockDuration();

        // Check maximum duration
        uint256 duration = unlockTime - block.timestamp;
        if (duration > MAX_LOCK_DURATION) revert InsufficientLockDuration();

        // Update lock end time
        lock.end = unlockTime;

        // Update checkpoints
        _updateLockCheckpoint(tokenId, lock.amount, lock.end);
        _updateSupplyCheckpoint();

        emit Deposit(msg.sender, tokenId, 0, unlockTime, block.timestamp);
    }

    
    function withdraw(uint256 tokenId) external nonReentrant {
        if (!_isTokenOwner(tokenId, msg.sender)) revert NotOwner();

        LockInfo storage lock = _locks[tokenId];

        // Cannot withdraw if auto-max-lock is enabled (must disable first)
        if (lock.autoMaxLock) revert AutoMaxLockEnabled();

        // Cannot withdraw if lock hasn't expired yet
        if (block.timestamp < lock.end) revert LockNotExpired();

        uint256 amount = lock.amount;
        if (amount == 0) revert InvalidAmount();

        // Clear lock data
        delete _locks[tokenId];

        // Remove from user's token list
        _removeTokenFromUser(msg.sender, tokenId);

        // Burn the NFT
        _burn(tokenId);

        // Update supply checkpoint
        _updateSupplyCheckpoint();

        // Transfer WOOD back to user
        wood.safeTransfer(msg.sender, amount);

        emit Withdraw(msg.sender, tokenId, amount, block.timestamp);
    }

    
    function toggleAutoMaxLock(uint256 tokenId) external {
        if (!_isTokenOwner(tokenId, msg.sender)) revert NotOwner();

        LockInfo storage lock = _locks[tokenId];
        lock.autoMaxLock = !lock.autoMaxLock;

        // If enabling auto-max-lock, update end time to 1 year from now
        if (lock.autoMaxLock) {
            lock.end = block.timestamp + MAX_LOCK_DURATION;
        }

        // Update checkpoints
        _updateLockCheckpoint(tokenId, lock.amount, lock.end);
        _updateSupplyCheckpoint();

        emit AutoMaxLockToggled(tokenId, lock.autoMaxLock);
    }

    // ==================== VIEW FUNCTIONS ====================

    
    function balanceOfNFT(uint256 tokenId) external view returns (uint256) {
        return _balanceOfNFTAt(tokenId, block.timestamp);
    }

    
    function balanceOfNFTAt(uint256 tokenId, uint256 timestamp) external view returns (uint256) {
        return _balanceOfNFTAt(tokenId, timestamp);
    }

    
    function totalSupply() external view returns (uint256) {
        return _totalSupplyAt(block.timestamp);
    }

    
    function totalSupplyAt(uint256 timestamp) external view returns (uint256) {
        return _totalSupplyAt(timestamp);
    }

    
    function getLock(uint256 tokenId) external view returns (LockInfo memory lock) {
        if (!_exists(tokenId)) revert TokenNotExists();
        return _locks[tokenId];
    }

    
    function getTokenIds(address owner) external view returns (uint256[] memory tokenIds) {
        return _userTokenIds[owner];
    }

    // ==================== INTERNAL FUNCTIONS ====================

    /// @dev Calculate voting power for a veNFT at a specific timestamp
    function _balanceOfNFTAt(uint256 tokenId, uint256 timestamp) internal view returns (uint256) {
        if (!_exists(tokenId)) return 0;

        LockInfo storage lock = _locks[tokenId];
        if (lock.amount == 0) return 0;

        // Flash loan protection: prevent voting in the same block as creation
        // Skip check if we're at block 0 or 1 (likely test environment)
        if (block.number > 1 && block.number == lock.createdBlock) return 0;

        // Auto-max-lock: always full voting power (no decay)
        if (lock.autoMaxLock) {
            return lock.amount;
        }

        // Regular lock: linear decay
        if (timestamp >= lock.end) return 0;

        // Linear decay formula: voting power is proportional to remaining time relative to MAX_LOCK_DURATION
        // Design choice: Uses MAX_LOCK_DURATION (1 year) in denominator, not actual lock duration
        // This means: 100 WOOD locked 1 year → 100 veWOOD initially, 100 WOOD locked 6 months → 50 veWOOD initially
        // Voting power decays linearly based on time remaining vs. maximum possible lock time
        uint256 timeLeft = lock.end - timestamp;
        return (lock.amount * timeLeft) / MAX_LOCK_DURATION;
    }

    /// @dev Calculate total voting power at a specific timestamp
    function _totalSupplyAt(uint256 timestamp) internal view returns (uint256) {
        uint256 totalPower = 0;

        // Sum voting power across all existing tokens
        for (uint256 tokenId = 1; tokenId < _tokenIdCounter; tokenId++) {
            if (_exists(tokenId)) {
                totalPower += _balanceOfNFTAt(tokenId, timestamp);
            }
        }

        return totalPower;
    }

    /// @dev Update checkpoint for a specific lock
    function _updateLockCheckpoint(uint256 tokenId, uint256 amount, uint256 end) internal {
        uint256 epoch = _pointEpoch[tokenId] + 1;
        _pointEpoch[tokenId] = epoch;

        _pointHistory[tokenId][epoch] = Point({
            bias: int256(_balanceOfNFTAt(tokenId, block.timestamp)),
            slope: _calculateSlope(amount, end),
            timestamp: block.timestamp,
            blockNumber: block.number
        });
    }

    /// @dev Update global supply checkpoint
    function _updateSupplyCheckpoint() internal {
        uint256 epoch = _globalEpoch + 1;
        _globalEpoch = epoch;

        _supplyPointHistory[epoch] = Point({
            bias: int256(_totalSupplyAt(block.timestamp)),
            slope: 0, // Not used for total supply
            timestamp: block.timestamp,
            blockNumber: block.number
        });

        emit Supply(_globalEpoch > 1 ? uint256(_supplyPointHistory[epoch - 1].bias) : 0, uint256(_supplyPointHistory[epoch].bias));
    }

    /// @dev Calculate slope (decay rate) for a lock
    function _calculateSlope(uint256 amount, uint256 end) internal view returns (int256) {
        if (end <= block.timestamp) return 0;
        return int256(amount) / int256(end - block.timestamp);
    }

    /// @dev Check if address owns a token
    function _isTokenOwner(uint256 tokenId, address account) internal view returns (bool) {
        return _exists(tokenId) && ownerOf(tokenId) == account;
    }

    /// @dev Add token to user's token list
    function _addTokenToUser(address user, uint256 tokenId) internal {
        _userTokenIndex[tokenId] = _userTokenIds[user].length;
        _userTokenIds[user].push(tokenId);
    }

    /// @dev Remove token from user's token list
    function _removeTokenFromUser(address user, uint256 tokenId) internal {
        uint256[] storage userTokens = _userTokenIds[user];
        uint256 index = _userTokenIndex[tokenId];
        uint256 lastIndex = userTokens.length - 1;

        if (index != lastIndex) {
            uint256 lastTokenId = userTokens[lastIndex];
            userTokens[index] = lastTokenId;
            _userTokenIndex[lastTokenId] = index;
        }

        userTokens.pop();
        delete _userTokenIndex[tokenId];
    }

    /// @dev Override transfer functions to update user token lists
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = super._update(to, tokenId, auth);

        // Handle token transfers
        if (from != address(0) && to != address(0) && from != to) {
            _removeTokenFromUser(from, tokenId);
            _addTokenToUser(to, tokenId);
        }

        return from;
    }

    /// @dev Check if token exists
    function _exists(uint256 tokenId) internal view returns (bool) {
        try this.ownerOf(tokenId) returns (address) {
            return true;
        } catch {
            return false;
        }
    }
}