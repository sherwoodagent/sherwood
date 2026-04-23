// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OFT} from "@layerzerolabs/lz-evm-oapp-v2/contracts/oft/OFT.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title WoodToken — LayerZero OFT + ERC20Votes with hard 1B supply cap
/// @notice Only the Minter contract can mint. Minting gracefully caps at MAX_SUPPLY.
///         ERC20Votes delegation enables Snapshot-style off-chain governance;
///         on-chain guardian voting runs through GuardianRegistry's own
///         per-delegate-per-delegator checkpoints, not this contract.
contract WoodToken is OFT, ERC20Permit, ERC20Votes {
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18; // 1B tokens

    address public immutable minter;

    error OnlyMinter();

    modifier onlyMinter() {
        if (msg.sender != minter) revert OnlyMinter();
        _;
    }

    /// @param _lzEndpoint LayerZero endpoint on this chain
    /// @param _delegate   LayerZero oApp delegate (usually deployer / multisig).
    ///                    Also becomes the contract's `Ownable` owner.
    /// @param _minter     Address of the Minter contract — sole mint authority
    constructor(address _lzEndpoint, address _delegate, address _minter)
        OFT("Wood Token", "WOOD", _lzEndpoint, _delegate)
        ERC20Permit("Wood Token")
        Ownable(_delegate)
    {
        if (_minter == address(0)) revert OnlyMinter();
        minter = _minter;
    }

    /// @notice Mint `amount` tokens to `to`. If minting the full amount would exceed
    ///         MAX_SUPPLY, only the remaining mintable amount is minted (no revert).
    /// @return minted The actual number of tokens minted (may be less than `amount`).
    function mint(address to, uint256 amount) external onlyMinter returns (uint256 minted) {
        uint256 remaining = totalMintable();
        if (remaining == 0) return 0;

        minted = amount > remaining ? remaining : amount;
        _mint(to, minted);
    }

    /// @notice Returns how many tokens can still be minted before hitting the cap.
    function totalMintable() public view returns (uint256) {
        return MAX_SUPPLY - totalSupply();
    }

    // ─────────────────────────────────────────────────────────────────
    // Diamond resolution — OZ v5 composes hooks through `_update` and
    // `nonces`; multi-inherit requires explicit override with super-walk.
    // ─────────────────────────────────────────────────────────────────

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    /// @notice Match OFT's default CLOCK_MODE (timestamp-based, EIP-6372).
    /// @dev `clock()` on ERC20Votes defaults to block numbers. We override to
    ///      timestamps so the checkpoint domain matches GuardianRegistry's
    ///      timestamp-keyed `Trace224` checkpoints.
    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }
}
