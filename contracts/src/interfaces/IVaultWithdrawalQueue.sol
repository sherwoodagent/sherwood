// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IVaultWithdrawalQueue
/// @notice Interface for the async withdrawal queue paired with `SyndicateVault`.
///         Holders escrow shares into the queue while strategies are unwound off-chain;
///         once the vault has sufficient idle assets they `claim` to redeem at the
///         live NAV recorded at claim time, or `cancel` to recover their shares.
interface IVaultWithdrawalQueue {
    // ── Errors ──
    error NotVault();
    error NotQueueOwner();
    error AlreadyClaimed();
    error AlreadyCancelled();
    error RequestNotFound();
    error VaultLocked();
    error ZeroShares();
    error InsufficientShares();
    error TransferFailed();

    // ── Structs ──
    struct Request {
        address owner; // owner of the escrowed shares (and recipient on claim)
        uint128 shares; // shares escrowed in the queue
        uint40 requestedAt; // block.timestamp when queued
        bool claimed;
        bool cancelled;
    }

    // ── Events ──
    event WithdrawalQueued(uint256 indexed requestId, address indexed owner, uint256 shares);
    event WithdrawalClaimed(uint256 indexed requestId, address indexed owner, uint256 shares, uint256 assets);
    event WithdrawalCancelled(uint256 indexed requestId, address indexed owner, uint256 shares);

    // ── External ──
    function vault() external view returns (address);
    function queueRequest(address owner, uint256 shares) external returns (uint256 requestId);
    function claim(uint256 requestId) external returns (uint256 assets);
    function cancel(uint256 requestId) external;

    // ── Views ──
    function getRequest(uint256 requestId) external view returns (Request memory);
    function pendingShares() external view returns (uint256);
    function getRequestsByOwner(address owner_) external view returns (uint256[] memory);
    function nextRequestId() external view returns (uint256);
}
