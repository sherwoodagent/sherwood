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
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
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

    /// @notice ERC-8004 agent identity registry (ERC-721)
    IERC721 private _agentRegistry;

    /// @notice Cumulative deposits for profit calculation
    uint256 private _totalDeposited;

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
        bool openDeposits_,
        address agentRegistry_
    ) external initializer {
        if (owner_ == address(0)) revert InvalidOwner();
        if (caps_.maxPerTx == 0) revert InvalidMaxPerTx();
        if (caps_.maxDailyTotal == 0) revert InvalidMaxDailyTotal();
        if (caps_.maxBorrowRatio > 10000) revert BorrowRatioTooHigh();
        if (executorImpl_ == address(0)) revert InvalidExecutorImpl();
        if (agentRegistry_ == address(0)) revert InvalidAgentRegistry();

        __ERC4626_init(asset_);
        __ERC20_init(name_, symbol_);
        __Ownable_init(owner_);
        __Pausable_init();

        _syndicateCaps = caps_;
        _dailySpendResetDay = block.timestamp / 1 days;
        _executorImpl = executorImpl_;
        _openDeposits = openDeposits_;
        _agentRegistry = IERC721(agentRegistry_);

        for (uint256 i = 0; i < initialTargets_.length; i++) {
            if (initialTargets_[i] == address(0)) revert InvalidTarget();
            _allowedTargets.add(initialTargets_[i]);
        }
    }

    // ==================== LP FUNCTIONS ====================

    /// @inheritdoc ISyndicateVault
    function ragequit(address receiver) external whenNotPaused returns (uint256 assets) {
        uint256 shares = balanceOf(msg.sender);
        if (shares == 0) revert NoShares();

        assets = redeem(shares, receiver, msg.sender);

        emit Ragequit(msg.sender, shares, assets);
    }

    // ==================== BATCH EXECUTION ====================

    /// @inheritdoc ISyndicateVault
    function executeBatch(BatchExecutorLib.Call[] calldata calls, uint256 assetAmount) external whenNotPaused {
        AgentConfig storage agent = _agents[msg.sender];
        if (!agent.active) revert NotActiveAgent();

        // --- Layer 1: Syndicate caps ---

        // Per-tx cap (use the tighter of syndicate vs agent limit)
        uint256 effectiveMaxPerTx = agent.maxPerTx < _syndicateCaps.maxPerTx ? agent.maxPerTx : _syndicateCaps.maxPerTx;
        if (assetAmount > effectiveMaxPerTx) revert ExceedsPerTxCap();

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
        if (agent.spentToday + assetAmount > effectiveDailyLimit) revert ExceedsAgentDailyLimit();

        // Syndicate combined daily limit
        if (_dailySpendTotal + assetAmount > _syndicateCaps.maxDailyTotal) revert ExceedsSyndicateDailyLimit();

        // Update spend tracking
        agent.spentToday += assetAmount;
        _dailySpendTotal += assetAmount;

        // --- Allowlist check ---
        for (uint256 i = 0; i < calls.length; i++) {
            if (!_allowedTargets.contains(calls[i].target)) revert TargetNotAllowed(calls[i].target);
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
        if (!success) revert SimulationFailed();
        return abi.decode(returnData, (BatchExecutorLib.CallResult[]));
    }

    // ==================== TARGET MANAGEMENT ====================

    /// @inheritdoc ISyndicateVault
    function addTarget(address target) external onlyOwner {
        if (target == address(0)) revert InvalidTarget();
        if (!_allowedTargets.add(target)) revert TargetAlreadyAllowed();
        emit TargetAdded(target);
    }

    /// @inheritdoc ISyndicateVault
    function removeTarget(address target) external onlyOwner {
        if (!_allowedTargets.remove(target)) revert TargetNotInAllowlist();
        emit TargetRemoved(target);
    }

    /// @inheritdoc ISyndicateVault
    function addTargets(address[] calldata targets) external onlyOwner {
        for (uint256 i = 0; i < targets.length; i++) {
            if (targets[i] == address(0)) revert InvalidTarget();
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
        if (depositor == address(0)) revert InvalidDepositor();
        if (!_approvedDepositors.add(depositor)) revert DepositorAlreadyApproved();
        emit DepositorApproved(depositor);
    }

    /// @inheritdoc ISyndicateVault
    function removeDepositor(address depositor) external onlyOwner {
        if (!_approvedDepositors.remove(depositor)) revert DepositorNotApproved();
        emit DepositorRemoved(depositor);
    }

    /// @inheritdoc ISyndicateVault
    function approveDepositors(address[] calldata depositors) external onlyOwner {
        for (uint256 i = 0; i < depositors.length; i++) {
            if (depositors[i] == address(0)) revert InvalidDepositor();
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

    /// @inheritdoc ISyndicateVault
    function totalDeposited() external view returns (uint256) {
        return _totalDeposited;
    }

    /// @inheritdoc ISyndicateVault
    function getAgentOperators() external view returns (address[] memory) {
        uint256 len = _agentSet.length();
        address[] memory operators = new address[](len);
        for (uint256 i = 0; i < len; i++) {
            operators[i] = _agents[_agentSet.at(i)].operatorEOA;
        }
        return operators;
    }

    // ==================== ADMIN ====================

    /// @inheritdoc ISyndicateVault
    function registerAgent(
        uint256 agentId,
        address pkpAddress,
        address operatorEOA,
        uint256 maxPerTx,
        uint256 dailyLimit
    ) external onlyOwner {
        if (pkpAddress == address(0)) revert InvalidPKPAddress();
        if (operatorEOA == address(0)) revert InvalidOperatorEOA();
        if (_agents[pkpAddress].active) revert AgentAlreadyRegistered();

        // Verify ERC-8004 identity: NFT must be owned by operatorEOA or vault owner (syndicate creator)
        address nftOwner = _agentRegistry.ownerOf(agentId);
        if (nftOwner != operatorEOA && nftOwner != owner()) revert NotAgentOwner();

        // Agent limits can't exceed syndicate caps
        if (maxPerTx > _syndicateCaps.maxPerTx) revert AgentMaxPerTxExceedsCap();
        if (dailyLimit > _syndicateCaps.maxDailyTotal) revert AgentDailyLimitExceedsCap();

        _agents[pkpAddress] = AgentConfig({
            agentId: agentId,
            pkpAddress: pkpAddress,
            operatorEOA: operatorEOA,
            maxPerTx: maxPerTx,
            dailyLimit: dailyLimit,
            spentToday: 0,
            lastResetDay: block.timestamp / 1 days,
            active: true
        });

        _agentSet.add(pkpAddress);

        emit AgentRegistered(agentId, pkpAddress, operatorEOA, maxPerTx, dailyLimit);
    }

    /// @inheritdoc ISyndicateVault
    function removeAgent(address pkpAddress) external onlyOwner {
        if (!_agents[pkpAddress].active) revert AgentNotActive();

        _agents[pkpAddress].active = false;
        _agentSet.remove(pkpAddress);

        emit AgentRemoved(pkpAddress);
    }

    /// @inheritdoc ISyndicateVault
    function updateSyndicateCaps(SyndicateCaps calldata caps) external onlyOwner {
        if (caps.maxPerTx == 0) revert InvalidMaxPerTx();
        if (caps.maxDailyTotal == 0) revert InvalidMaxDailyTotal();
        if (caps.maxBorrowRatio > 10000) revert BorrowRatioTooHigh();

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

    /// @dev Block deposits when paused or depositor not approved. Track totalDeposited.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
    {
        if (!_openDeposits && !_approvedDepositors.contains(receiver)) revert NotApprovedDepositor();
        _totalDeposited += assets;
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address _owner, uint256 assets, uint256 shares)
        internal
        override
        whenNotPaused
    {
        if (assets > _totalDeposited) {
            _totalDeposited = 0;
        } else {
            _totalDeposited -= assets;
        }
        super._withdraw(caller, receiver, _owner, assets, shares);
    }

    // ==================== UUPS ====================

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ==================== RECEIVE ====================

    /// @notice Accept ETH (needed for WETH unwrapping and protocol interactions)
    receive() external payable {}
}
