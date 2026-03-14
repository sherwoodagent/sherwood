// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IStrategyRegistry, StrategyRecord} from "./interfaces/IStrategyRegistry.sol";
import {AccessControlEnumerableUpgradeable} from
    "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title StrategyRegistry
 * @notice Append-only registry of strategies with ERC-8004 identity verification.
 *         Adapted from mamo-contracts MarketRegistry + MamoStrategyRegistry patterns.
 * @dev UUPS upgradeable. Strategies are soft-deleted (deactivated, never removed).
 */
contract StrategyRegistry is
    IStrategyRegistry,
    Initializable,
    AccessControlEnumerableUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using EnumerableSet for EnumerableSet.UintSet;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// @notice Next strategy ID to assign (1-indexed)
    uint256 private _nextStrategyId;

    /// @notice Strategy ID => record
    mapping(uint256 => StrategyRecord) private _strategies;

    /// @notice Strategy type ID => set of strategy IDs
    mapping(uint256 => EnumerableSet.UintSet) private _strategiesByType;

    /// @notice Creator address => set of strategy IDs
    mapping(address => EnumerableSet.UintSet) private _strategiesByCreator;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address admin, address guardian) external initializer {
        require(admin != address(0), "Invalid admin");
        require(guardian != address(0), "Invalid guardian");

        __AccessControlEnumerable_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);

        _nextStrategyId = 1;
    }

    // ==================== PERMISSIONLESS ====================

    /// @inheritdoc IStrategyRegistry
    function registerStrategy(
        address implementation,
        uint256 strategyTypeId,
        string calldata name,
        string calldata metadataURI
    ) external whenNotPaused returns (uint256 strategyId) {
        require(implementation != address(0), "Invalid implementation");
        require(strategyTypeId != 0, "Invalid strategy type");
        require(bytes(name).length > 0, "Empty name");

        // TODO: Verify msg.sender has ERC-8004 identity
        // For MVP, any address can register

        strategyId = _nextStrategyId++;

        _strategies[strategyId] = StrategyRecord({
            implementation: implementation,
            creator: msg.sender,
            strategyTypeId: strategyTypeId,
            active: true,
            name: name,
            metadataURI: metadataURI
        });

        _strategiesByType[strategyTypeId].add(strategyId);
        _strategiesByCreator[msg.sender].add(strategyId);

        emit StrategyRegistered(strategyId, msg.sender, implementation, strategyTypeId, name);
    }

    /// @inheritdoc IStrategyRegistry
    function deactivateStrategy(uint256 strategyId) external whenNotPaused {
        StrategyRecord storage record = _strategies[strategyId];
        require(record.implementation != address(0), "Strategy not found");
        require(record.creator == msg.sender || hasRole(DEFAULT_ADMIN_ROLE, msg.sender), "Not authorized");
        require(record.active, "Already inactive");

        record.active = false;

        emit StrategyDeactivated(strategyId);
    }

    // ==================== VIEWS ====================

    /// @inheritdoc IStrategyRegistry
    function getStrategy(uint256 strategyId) external view returns (StrategyRecord memory) {
        require(_strategies[strategyId].implementation != address(0), "Strategy not found");
        return _strategies[strategyId];
    }

    /// @inheritdoc IStrategyRegistry
    function getStrategiesByType(uint256 strategyTypeId) external view returns (uint256[] memory) {
        return _strategiesByType[strategyTypeId].values();
    }

    /// @inheritdoc IStrategyRegistry
    function getStrategiesByCreator(address creator) external view returns (uint256[] memory) {
        return _strategiesByCreator[creator].values();
    }

    /// @inheritdoc IStrategyRegistry
    function strategyCount() external view returns (uint256) {
        return _nextStrategyId - 1;
    }

    /// @inheritdoc IStrategyRegistry
    function isStrategyActive(uint256 strategyId) external view returns (bool) {
        return _strategies[strategyId].active;
    }

    // ==================== GUARDIAN ====================

    /// @inheritdoc IStrategyRegistry
    function pause() external onlyRole(GUARDIAN_ROLE) {
        _pause();
    }

    /// @inheritdoc IStrategyRegistry
    function unpause() external onlyRole(GUARDIAN_ROLE) {
        _unpause();
    }

    // ==================== UUPS ====================

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
