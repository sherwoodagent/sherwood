// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Minimal ERC-721 mock for ERC-8004 IdentityRegistry in tests
contract MockAgentRegistry is ERC721 {
    uint256 private _nextId;

    constructor() ERC721("Agent Identity", "AGENT") {}

    /// @notice Mint a new agent NFT to the given address
    function mint(address to) external returns (uint256 agentId) {
        agentId = ++_nextId;
        _mint(to, agentId);
    }

    /// @notice Mint a specific tokenId to the given address (for test convenience)
    function mintId(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}
