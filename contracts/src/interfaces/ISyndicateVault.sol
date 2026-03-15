// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BatchExecutorLib} from "../BatchExecutorLib.sol";

interface ISyndicateVault {
    // ── Errors ──
    error InvalidOwner();
    error InvalidMaxPerTx();
    error InvalidMaxDailyTotal();
    error BorrowRatioTooHigh();
    error InvalidExecutorImpl();
    error InvalidTarget();
    error NoShares();
    error NotActiveAgent();
    error ExceedsPerTxCap();
    error ExceedsAgentDailyLimit();
    error ExceedsSyndicateDailyLimit();
    error TargetNotAllowed(address target);
    error SimulationFailed();
    error TargetAlreadyAllowed();
    error TargetNotInAllowlist();
    error InvalidDepositor();
    error DepositorAlreadyApproved();
    error DepositorNotApproved();
    error NotApprovedDepositor();
    error InvalidPKPAddress();
    error InvalidOperatorEOA();
    error AgentAlreadyRegistered();
    error AgentMaxPerTxExceedsCap();
    error AgentDailyLimitExceedsCap();
    error AgentNotActive();
    error InvalidAgentRegistry();
    error NotAgentOwner();

    // ── Syndicate-Level Caps (hard limits for ALL agents) ──
    struct SyndicateCaps {
        uint256 maxPerTx; // Max asset amount per single tx
        uint256 maxDailyTotal; // Max combined daily spend across all agents
        uint256 maxBorrowRatio; // Max LTV in basis points (e.g., 7500 = 75%)
    }

    // ── Per-Agent Config ──
    struct AgentConfig {
        uint256 agentId; // ERC-8004 identity token ID
        address pkpAddress; // Lit PKP wallet address (the executor)
        address operatorEOA; // Agent's own wallet (the identity)
        uint256 maxPerTx; // Agent-specific per-tx cap (≤ syndicate cap)
        uint256 dailyLimit; // Agent-specific daily limit (≤ syndicate cap)
        uint256 spentToday; // Tracks daily spend
        uint256 lastResetDay; // Day number for daily reset
        bool active;
    }

    // ── LP Functions ──
    function ragequit(address receiver) external returns (uint256 assets);

    // ── Agent Functions (called by Lit PKP) ──
    function executeBatch(BatchExecutorLib.Call[] calldata calls, uint256 assetAmount) external;

    // ── Simulation (callable by anyone via eth_call) ──
    function simulateBatch(BatchExecutorLib.Call[] calldata calls)
        external
        returns (BatchExecutorLib.CallResult[] memory);

    // ── Target Allowlist ──
    function addTarget(address target) external;
    function removeTarget(address target) external;
    function addTargets(address[] calldata targets) external;
    function isAllowedTarget(address target) external view returns (bool);
    function getAllowedTargets() external view returns (address[] memory);

    // ── Depositor Whitelist ──
    function approveDepositor(address depositor) external;
    function removeDepositor(address depositor) external;
    function approveDepositors(address[] calldata depositors) external;
    function isApprovedDepositor(address depositor) external view returns (bool);
    function getApprovedDepositors() external view returns (address[] memory);
    function setOpenDeposits(bool open) external;
    function openDeposits() external view returns (bool);

    // ── Views ──
    function getAgentConfig(address pkpAddress) external view returns (AgentConfig memory);
    function getSyndicateCaps() external view returns (SyndicateCaps memory);
    function getAgentCount() external view returns (uint256);
    function getDailySpendTotal() external view returns (uint256);
    function isAgent(address pkpAddress) external view returns (bool);
    function getExecutorImpl() external view returns (address);
    function totalDeposited() external view returns (uint256);
    function getAgentOperators() external view returns (address[] memory);

    // ── Admin (syndicate creator) ──
    function registerAgent(
        uint256 agentId,
        address pkpAddress,
        address operatorEOA,
        uint256 maxPerTx,
        uint256 dailyLimit
    ) external;
    function removeAgent(address pkpAddress) external;
    function updateSyndicateCaps(SyndicateCaps calldata caps) external;
    function pause() external;
    function unpause() external;

    // ── Events ──
    event AgentRegistered(
        uint256 indexed agentId,
        address indexed pkpAddress,
        address indexed operatorEOA,
        uint256 maxPerTx,
        uint256 dailyLimit
    );
    event AgentRemoved(address indexed pkpAddress);
    event BatchExecuted(address indexed agent, uint256 callCount, uint256 assetAmount);
    event Ragequit(address indexed lp, uint256 shares, uint256 assets);
    event SyndicateCapsUpdated(uint256 maxPerTx, uint256 maxDailyTotal, uint256 maxBorrowRatio);
    event TargetAdded(address indexed target);
    event TargetRemoved(address indexed target);
    event DepositorApproved(address indexed depositor);
    event DepositorRemoved(address indexed depositor);
    event OpenDepositsUpdated(bool open);
}
