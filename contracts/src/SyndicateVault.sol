// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISyndicateVault} from "./interfaces/ISyndicateVault.sol";
import {BatchExecutorLib} from "./BatchExecutorLib.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
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
 *   The vault is the onchain identity — it holds all positions (mTokens, borrows,
 *   swapped tokens) via delegatecall to a shared BatchExecutorLib. Deploy one
 *   executor lib, share it across all syndicates.
 *
 *   Two-layer permission model:
 *     Layer 1 (onchain): Syndicate caps + target allowlist enforced here.
 *     Layer 2 (offchain): Agent-level Lit Action policies.
 *
 *   Agents call executeBatch() with an array of protocol calls. The vault checks
 *   caps and allowlist, then delegatecalls the executor lib which makes the calls
 *   as the vault.
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
    // WARNING: Never reorder existing slots. Append-only for UUPS safety.

    /// @notice Syndicate-level hard caps
    SyndicateCaps private _syndicateCaps;

    /// @notice PKP address => agent config
    mapping(address => AgentConfig) private _agents;

    /// @notice Set of all registered PKP addresses
    EnumerableSet.AddressSet private _agentSet;

    /// @notice Combined daily spend tracking across all agents
    uint256 private _dailySpendTotal;
    uint256 private _dailySpendResetDay;

    // ── New storage (appended after existing slots) ──

    /// @notice Shared executor lib (stateless, called via delegatecall)
    address private _executorImpl;

    /// @notice Approved protocol targets for batch execution
    EnumerableSet.AddressSet private _allowedTargets;

    /// @notice Approved depositor addresses (whitelist for deposits)
    EnumerableSet.AddressSet private _approvedDepositors;

    /// @notice If true, anyone can deposit (skip whitelist check)
    bool private _openDeposits;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        address owner_,
        SyndicateCaps memory caps_,
        address executorImpl_,
        address[] memory initialTargets_,
        bool openDeposits_
    ) external initializer {
        require(owner_ != address(0), "Invalid owner");
        require(caps_.maxPerTx > 0, "Invalid maxPerTx");
        require(caps_.maxDailyTotal > 0, "Invalid maxDailyTotal");
        require(caps_.maxBorrowRatio <= 10000, "Borrow ratio > 100%");
        require(executorImpl_ != address(0), "Invalid executor impl");

        __ERC4626_init(asset_);
        __ERC20_init(name_, symbol_);
        __Ownable_init(owner_);
        __Pausable_init();

        _syndicateCaps = caps_;
        _dailySpendResetDay = block.timestamp / 1 days;
        _executorImpl = executorImpl_;
        _openDeposits = openDeposits_;

        for (uint256 i = 0; i < initialTargets_.length; i++) {
            require(initialTargets_[i] != address(0), "Invalid target");
            _allowedTargets.add(initialTargets_[i]);
        }
    }

    // ==================== LP FUNCTIONS ====================

    /// @inheritdoc ISyndicateVault
    function ragequit(address receiver) external whenNotPaused returns (uint256 assets) {
        uint256 shares = balanceOf(msg.sender);
        require(shares > 0, "No shares");

        assets = redeem(shares, receiver, msg.sender);

        emit Ragequit(msg.sender, shares, assets);
    }

    // ==================== BATCH EXECUTION ====================

    /// @inheritdoc ISyndicateVault
    function executeBatch(BatchExecutorLib.Call[] calldata calls, uint256 assetAmount) external whenNotPaused {
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

        // --- Allowlist check ---
        for (uint256 i = 0; i < calls.length; i++) {
            require(_allowedTargets.contains(calls[i].target), "Target not allowed");
        }

        // --- Delegatecall to shared executor lib ---
        (bool success, bytes memory returnData) =
            _executorImpl.delegatecall(abi.encodeCall(BatchExecutorLib.executeBatch, (calls)));
        if (!success) {
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }

        emit BatchExecuted(msg.sender, calls.length, assetAmount);
    }

    /// @inheritdoc ISyndicateVault
    function simulateBatch(BatchExecutorLib.Call[] calldata calls)
        external
        returns (BatchExecutorLib.CallResult[] memory)
    {
        // Allowlist check (return error result instead of reverting)
        for (uint256 i = 0; i < calls.length; i++) {
            if (!_allowedTargets.contains(calls[i].target)) {
                BatchExecutorLib.CallResult[] memory results = new BatchExecutorLib.CallResult[](calls.length);
                results[i] = BatchExecutorLib.CallResult({success: false, returnData: bytes("Target not allowed")});
                return results;
            }
        }

        (bool success, bytes memory returnData) =
            _executorImpl.delegatecall(abi.encodeCall(BatchExecutorLib.simulateBatch, (calls)));
        require(success, "Simulation delegatecall failed");
        return abi.decode(returnData, (BatchExecutorLib.CallResult[]));
    }

    // ==================== TARGET MANAGEMENT ====================

    /// @inheritdoc ISyndicateVault
    function addTarget(address target) external onlyOwner {
        require(target != address(0), "Invalid target");
        require(_allowedTargets.add(target), "Already allowed");
        emit TargetAdded(target);
    }

    /// @inheritdoc ISyndicateVault
    function removeTarget(address target) external onlyOwner {
        require(_allowedTargets.remove(target), "Not in allowlist");
        emit TargetRemoved(target);
    }

    /// @inheritdoc ISyndicateVault
    function addTargets(address[] calldata targets) external onlyOwner {
        for (uint256 i = 0; i < targets.length; i++) {
            require(targets[i] != address(0), "Invalid target");
            _allowedTargets.add(targets[i]);
            emit TargetAdded(targets[i]);
        }
    }

    /// @inheritdoc ISyndicateVault
    function isAllowedTarget(address target) external view returns (bool) {
        return _allowedTargets.contains(target);
    }

    /// @inheritdoc ISyndicateVault
    function getAllowedTargets() external view returns (address[] memory) {
        return _allowedTargets.values();
    }

    // ==================== DEPOSITOR WHITELIST ====================

    /// @inheritdoc ISyndicateVault
    function approveDepositor(address depositor) external onlyOwner {
        require(depositor != address(0), "Invalid depositor");
        require(_approvedDepositors.add(depositor), "Already approved");
        emit DepositorApproved(depositor);
    }

    /// @inheritdoc ISyndicateVault
    function removeDepositor(address depositor) external onlyOwner {
        require(_approvedDepositors.remove(depositor), "Not approved");
        emit DepositorRemoved(depositor);
    }

    /// @inheritdoc ISyndicateVault
    function approveDepositors(address[] calldata depositors) external onlyOwner {
        for (uint256 i = 0; i < depositors.length; i++) {
            require(depositors[i] != address(0), "Invalid depositor");
            _approvedDepositors.add(depositors[i]);
            emit DepositorApproved(depositors[i]);
        }
    }

    /// @inheritdoc ISyndicateVault
    function isApprovedDepositor(address depositor) external view returns (bool) {
        return _approvedDepositors.contains(depositor);
    }

    /// @inheritdoc ISyndicateVault
    function getApprovedDepositors() external view returns (address[] memory) {
        return _approvedDepositors.values();
    }

    /// @inheritdoc ISyndicateVault
    function setOpenDeposits(bool open) external onlyOwner {
        _openDeposits = open;
        emit OpenDepositsUpdated(open);
    }

    /// @inheritdoc ISyndicateVault
    function openDeposits() external view returns (bool) {
        return _openDeposits;
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

    /// @inheritdoc ISyndicateVault
    function getExecutorImpl() external view returns (address) {
        return _executorImpl;
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

    /// @dev Block deposits when paused or depositor not approved
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
    {
        require(_openDeposits || _approvedDepositors.contains(receiver), "Not approved depositor");
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

    // ==================== RECEIVE ====================

    /// @notice Accept ETH (needed for WETH unwrapping and protocol interactions)
    receive() external payable {}
}
