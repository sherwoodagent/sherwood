// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVaultWithdrawalQueue} from "../interfaces/IVaultWithdrawalQueue.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

interface IRedeemableVault {
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
    function redemptionsLocked() external view returns (bool);
}

/// @title VaultWithdrawalQueue
/// @notice Per-vault async withdrawal queue. Shares are escrowed in this contract
///         while a strategy proposal is active (`vault.redemptionsLocked() == true`);
///         after settlement anyone may `claim(requestId)` and the queue redeems the
///         escrowed shares against the vault at the post-settle NAV, forwarding
///         proceeds to the request's owner.
contract VaultWithdrawalQueue is IVaultWithdrawalQueue, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public immutable override vault;

    Request[] private _requests; // index 0 unused (sentinel)
    mapping(address => uint256[]) private _byOwner;
    uint256 private _pendingShares;

    constructor(address vault_) {
        if (vault_ == address(0)) revert NotVault();
        vault = vault_;
        _requests.push(); // sentinel slot at index 0
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert NotVault();
        _;
    }

    /// @inheritdoc IVaultWithdrawalQueue
    /// @dev Called by the vault inside `requestRedeem` after it has transferred
    ///      `shares` into this contract's custody.
    function queueRequest(address owner_, uint256 shares) external onlyVault returns (uint256 id) {
        if (shares == 0) revert ZeroShares();
        if (shares > type(uint128).max) revert InsufficientShares();
        id = _requests.length;
        // forge-lint: disable-next-line(unsafe-typecast)
        _requests.push(
            Request({
                owner: owner_,
                shares: uint128(shares),
                requestedAt: uint40(block.timestamp),
                claimed: false,
                cancelled: false
            })
        );
        _byOwner[owner_].push(id);
        _pendingShares += shares;
        emit WithdrawalQueued(id, owner_, shares);
    }

    /// @inheritdoc IVaultWithdrawalQueue
    /// @dev Inherits the vault's `whenNotPaused` gate transitively: this
    ///      function calls `vault.redeem`, which routes through `_withdraw`
    ///      (`whenNotPaused`). When the owner pauses the vault, claims are
    ///      blocked even if `redemptionsLocked() == false`. The `cancel` path
    ///      remains unpaused so escrowed shares are recoverable during a pause.
    function claim(uint256 requestId) external nonReentrant returns (uint256 assets) {
        if (requestId == 0 || requestId >= _requests.length) revert RequestNotFound();
        Request storage r = _requests[requestId];
        if (r.claimed) revert AlreadyClaimed();
        if (r.cancelled) revert AlreadyCancelled();
        if (IRedeemableVault(vault).redemptionsLocked()) revert VaultLocked();

        uint256 shares = uint256(r.shares);
        r.claimed = true;

        // Q-H2: decrement pendingShares AFTER the external redeem so the queue's
        // share balance and `_pendingShares` only diverge inside the same nonReentrant
        // window. Vault's `_withdraw` bypasses the reserve check for the queue caller,
        // so the live read of `pendingQueueShares()` during `redeem` is irrelevant for
        // the queue's own claim path. The `r.claimed` flag (set before the call)
        // continues to block double-claim re-entry.
        assets = IRedeemableVault(vault).redeem(shares, r.owner, address(this));
        _pendingShares -= shares;
        emit WithdrawalClaimed(requestId, r.owner, shares, assets);
    }

    /// @inheritdoc IVaultWithdrawalQueue
    /// @dev Unaffected by `vault.paused()` — the cancel path uses
    ///      `IERC20.transfer` (an `_update` call) which has no pause check.
    ///      LPs can always recover their escrowed shares.
    function cancel(uint256 requestId) external nonReentrant {
        if (requestId == 0 || requestId >= _requests.length) revert RequestNotFound();
        Request storage r = _requests[requestId];
        if (msg.sender != r.owner) revert NotQueueOwner();
        if (r.claimed) revert AlreadyClaimed();
        if (r.cancelled) revert AlreadyCancelled();

        uint256 shares = uint256(r.shares);
        r.cancelled = true;
        _pendingShares -= shares;
        IERC20(vault).safeTransfer(r.owner, shares);
        emit WithdrawalCancelled(requestId, r.owner, shares);
    }

    /// @inheritdoc IVaultWithdrawalQueue
    function getRequest(uint256 id) external view returns (Request memory) {
        return _requests[id];
    }

    /// @inheritdoc IVaultWithdrawalQueue
    function pendingShares() external view returns (uint256) {
        return _pendingShares;
    }

    /// @inheritdoc IVaultWithdrawalQueue
    function getRequestsByOwner(address owner_) external view returns (uint256[] memory) {
        return _byOwner[owner_];
    }

    /// @inheritdoc IVaultWithdrawalQueue
    function nextRequestId() external view returns (uint256) {
        return _requests.length;
    }
}
