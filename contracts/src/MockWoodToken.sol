// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockWoodToken — Simple ERC-20 for testing ve(3,3) contracts
/// @notice Simplified version of WoodToken for testing without LayerZero dependencies
contract MockWoodToken is ERC20, Ownable {
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18; // 1B tokens

    address public minter;

    error OnlyMinter();
    error OnlyOwner();

    modifier onlyMinter() {
        if (msg.sender != minter) revert OnlyMinter();
        _;
    }

    /// @param _owner Token owner
    constructor(address _owner) ERC20("Wood Token", "WOOD") Ownable(_owner) {}

    /// @notice Set the minter address (can only be called once by owner)
    function setMinter(address _minter) external onlyOwner {
        if (minter != address(0)) revert OnlyOwner();
        minter = _minter;
    }

    /// @notice Owner can mint for testing purposes
    function ownerMint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
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
}