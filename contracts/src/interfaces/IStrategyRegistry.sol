// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Strategy metadata stored on-chain
struct StrategyRecord {
    address implementation; // Strategy contract address
    address creator; // ERC-8004 identity of the creator
    uint256 strategyTypeId; // Category: 1=lending, 2=trading, 3=sniping, etc.
    bool active;
    string name;
    string metadataURI; // IPFS/Arweave link to SKILL.md descriptor
}

interface IStrategyRegistry {
    // ── Mutators ──
    function registerStrategy(
        address implementation,
        uint256 strategyTypeId,
        string calldata name,
        string calldata metadataURI
    ) external returns (uint256 strategyId);

    function deactivateStrategy(uint256 strategyId) external;

    // ── Views ──
    function getStrategy(uint256 strategyId) external view returns (StrategyRecord memory);
    function getStrategiesByType(uint256 strategyTypeId) external view returns (uint256[] memory);
    function getStrategiesByCreator(address creator) external view returns (uint256[] memory);
    function strategyCount() external view returns (uint256);
    function isStrategyActive(uint256 strategyId) external view returns (bool);

    // ── Admin ──
    function pause() external;
    function unpause() external;

    // ── Events ──
    event StrategyRegistered(
        uint256 indexed strategyId, address indexed creator, address implementation, uint256 strategyTypeId, string name
    );
    event StrategyDeactivated(uint256 indexed strategyId);
}
