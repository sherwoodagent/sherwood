// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BatchExecutorLib} from "../BatchExecutorLib.sol";

interface ISyndicateVault {
    // ── Syndicate-Level Caps (hard limits for ALL agents) ──
    struct SyndicateCaps {
        uint256 maxPerTx; // Max asset amount per single tx
        uint256 maxDailyTotal; // Max combined daily spend across all agents
        uint256 maxBorrowRatio; // Max LTV in basis points (e.g., 7500 = 75%)
    }

    // ── Per-Agent Config ──
    struct AgentConfig {
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

    // ── Views ──
    function getAgentConfig(address pkpAddress) external view returns (AgentConfig memory);
    function getSyndicateCaps() external view returns (SyndicateCaps memory);
    function getAgentCount() external view returns (uint256);
    function getDailySpendTotal() external view returns (uint256);
    function isAgent(address pkpAddress) external view returns (bool);
    function getExecutorImpl() external view returns (address);

    // ── Admin (syndicate creator) ──
    function registerAgent(address pkpAddress, address operatorEOA, uint256 maxPerTx, uint256 dailyLimit) external;
    function removeAgent(address pkpAddress) external;
    function updateSyndicateCaps(SyndicateCaps calldata caps) external;
    function pause() external;
    function unpause() external;

    // ── Events ──
    event AgentRegistered(
        address indexed pkpAddress, address indexed operatorEOA, uint256 maxPerTx, uint256 dailyLimit
    );
    event AgentRemoved(address indexed pkpAddress);
    event BatchExecuted(address indexed agent, uint256 callCount, uint256 assetAmount);
    event Ragequit(address indexed lp, uint256 shares, uint256 assets);
    event SyndicateCapsUpdated(uint256 maxPerTx, uint256 maxDailyTotal, uint256 maxBorrowRatio);
    event TargetAdded(address indexed target);
    event TargetRemoved(address indexed target);
}
