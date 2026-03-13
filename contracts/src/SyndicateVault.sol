// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISyndicateVault} from "./interfaces/ISyndicateVault.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title SyndicateVault
 * @notice ERC-4626 vault for agent-managed investment syndicates.
 *
 *   Two-layer permission model:
 *     Layer 1 (on-chain): Syndicate-level caps enforced in this contract.
 *       No agent can exceed these regardless of their off-chain policies.
 *     Layer 2 (off-chain): Agent-level Lit Action policies enforce tighter
 *       per-agent limits. The Lit PKP won't sign if policy fails.
 *
 *   Agents interact via Lit PKP wallets. The agent's EOA is their identity;
 *   the PKP is the executor. Human operator registers agent PKPs and sets
 *   both syndicate caps and per-agent limits.
 *
 *   LPs can ragequit at any time for their pro-rata share.
 */
contract SyndicateVault is
    ISyndicateVault,
    Initializable,
    ERC4626Upgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ==================== STORAGE ====================

    /// @notice Syndicate-level hard caps
    SyndicateCaps private _syndicateCaps;

    /// @notice PKP address => agent config
    mapping(address => AgentConfig) private _agents;

    /// @notice Set of all registered PKP addresses
    EnumerableSet.AddressSet private _agentSet;

    /// @notice Combined daily spend tracking across all agents
    uint256 private _dailySpendTotal;
    uint256 private _dailySpendResetDay;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        address owner_,
        SyndicateCaps memory caps_
    ) external initializer {
        require(owner_ != address(0), "Invalid owner");
        require(caps_.maxPerTx > 0, "Invalid maxPerTx");
        require(caps_.maxDailyTotal > 0, "Invalid maxDailyTotal");
        require(caps_.maxBorrowRatio <= 10000, "Borrow ratio > 100%");

        __ERC4626_init(asset_);
        __ERC20_init(name_, symbol_);
        __Ownable_init(owner_);
        __Pausable_init();

        _syndicateCaps = caps_;
        _dailySpendResetDay = block.timestamp / 1 days;
    }

    // ==================== LP FUNCTIONS ====================

    /// @inheritdoc ISyndicateVault
    function ragequit(address receiver) external whenNotPaused returns (uint256 assets) {
        uint256 shares = balanceOf(msg.sender);
        require(shares > 0, "No shares");

        assets = redeem(shares, receiver, msg.sender);

        emit Ragequit(msg.sender, shares, assets);
    }

    // ==================== AGENT FUNCTIONS ====================

    /// @inheritdoc ISyndicateVault
    function executeStrategy(address strategy, bytes calldata data, uint256 assetAmount)
        external
        whenNotPaused
        returns (bytes memory)
    {
        AgentConfig storage agent = _agents[msg.sender];
        require(agent.active, "Not an active agent");

        // --- Layer 1: Syndicate caps ---

        // Per-tx cap (use the tighter of syndicate vs agent limit)
        uint256 effectiveMaxPerTx = agent.maxPerTx < _syndicateCaps.maxPerTx ? agent.maxPerTx : _syndicateCaps.maxPerTx;
        require(assetAmount <= effectiveMaxPerTx, "Exceeds per-tx cap");

        // Daily limit — reset if new day
        uint256 today = block.timestamp / 1 days;
        if (today > agent.lastResetDay) {
            agent.spentToday = 0;
            agent.lastResetDay = today;
        }
        if (today > _dailySpendResetDay) {
            _dailySpendTotal = 0;
            _dailySpendResetDay = today;
        }

        // Agent daily limit
        uint256 effectiveDailyLimit =
            agent.dailyLimit < _syndicateCaps.maxDailyTotal ? agent.dailyLimit : _syndicateCaps.maxDailyTotal;
        require(agent.spentToday + assetAmount <= effectiveDailyLimit, "Exceeds agent daily limit");

        // Syndicate combined daily limit
        require(_dailySpendTotal + assetAmount <= _syndicateCaps.maxDailyTotal, "Exceeds syndicate daily limit");

        // Update spend tracking
        agent.spentToday += assetAmount;
        _dailySpendTotal += assetAmount;

        // Approve strategy to pull assets from vault
        IERC20 asset_ = IERC20(asset());
        asset_.approve(strategy, assetAmount);

        // Execute the strategy call
        (bool success, bytes memory result) = strategy.call(data);
        require(success, "Strategy execution failed");

        // Revoke any remaining approval
        asset_.approve(strategy, 0);

        emit StrategyExecuted(msg.sender, strategy, assetAmount);

        return result;
    }

    // ==================== VIEWS ====================

    /// @inheritdoc ISyndicateVault
    function getAgentConfig(address pkpAddress) external view returns (AgentConfig memory) {
        return _agents[pkpAddress];
    }

    /// @inheritdoc ISyndicateVault
    function getSyndicateCaps() external view returns (SyndicateCaps memory) {
        return _syndicateCaps;
    }

    /// @inheritdoc ISyndicateVault
    function getAgentCount() external view returns (uint256) {
        return _agentSet.length();
    }

    /// @inheritdoc ISyndicateVault
    function getDailySpendTotal() external view returns (uint256) {
        uint256 today = block.timestamp / 1 days;
        if (today > _dailySpendResetDay) {
            return 0; // Would reset on next tx
        }
        return _dailySpendTotal;
    }

    /// @inheritdoc ISyndicateVault
    function isAgent(address pkpAddress) external view returns (bool) {
        return _agents[pkpAddress].active;
    }

    // ==================== ADMIN ====================

    /// @inheritdoc ISyndicateVault
    function registerAgent(address pkpAddress, address operatorEOA, uint256 maxPerTx, uint256 dailyLimit)
        external
        onlyOwner
    {
        require(pkpAddress != address(0), "Invalid PKP address");
        require(operatorEOA != address(0), "Invalid operator EOA");
        require(!_agents[pkpAddress].active, "Agent already registered");

        // Agent limits can't exceed syndicate caps
        require(maxPerTx <= _syndicateCaps.maxPerTx, "Agent maxPerTx > syndicate cap");
        require(dailyLimit <= _syndicateCaps.maxDailyTotal, "Agent dailyLimit > syndicate cap");

        _agents[pkpAddress] = AgentConfig({
            pkpAddress: pkpAddress,
            operatorEOA: operatorEOA,
            maxPerTx: maxPerTx,
            dailyLimit: dailyLimit,
            spentToday: 0,
            lastResetDay: block.timestamp / 1 days,
            active: true
        });

        _agentSet.add(pkpAddress);

        emit AgentRegistered(pkpAddress, operatorEOA, maxPerTx, dailyLimit);
    }

    /// @inheritdoc ISyndicateVault
    function removeAgent(address pkpAddress) external onlyOwner {
        require(_agents[pkpAddress].active, "Agent not active");

        _agents[pkpAddress].active = false;
        _agentSet.remove(pkpAddress);

        emit AgentRemoved(pkpAddress);
    }

    /// @inheritdoc ISyndicateVault
    function updateSyndicateCaps(SyndicateCaps calldata caps) external onlyOwner {
        require(caps.maxPerTx > 0, "Invalid maxPerTx");
        require(caps.maxDailyTotal > 0, "Invalid maxDailyTotal");
        require(caps.maxBorrowRatio <= 10000, "Borrow ratio > 100%");

        _syndicateCaps = caps;

        emit SyndicateCapsUpdated(caps.maxPerTx, caps.maxDailyTotal, caps.maxBorrowRatio);
    }

    /// @inheritdoc ISyndicateVault
    function pause() external onlyOwner {
        _pause();
    }

    /// @inheritdoc ISyndicateVault
    function unpause() external onlyOwner {
        _unpause();
    }

    // ==================== OVERRIDES ====================

    /// @dev Block deposits and withdrawals when paused
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
    {
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address _owner, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
    {
        super._withdraw(caller, receiver, _owner, assets, shares);
    }

    // ==================== UUPS ====================

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
