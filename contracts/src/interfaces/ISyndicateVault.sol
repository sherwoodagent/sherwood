// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BatchExecutorLib} from "../BatchExecutorLib.sol";

interface ISyndicateVault {
    // ── Errors ──
    error InvalidOwner();
    error InvalidExecutorImpl();
    error NoShares();
    error NotActiveAgent();
    error SimulationFailed();
    error InvalidDepositor();
    error DepositorAlreadyApproved();
    error DepositorNotApproved();
    error NotApprovedDepositor();
    error InvalidAgentAddress();
    error AgentAlreadyRegistered();
    error AgentNotActive();
    error InvalidAgentRegistry();
    error NotAgentOwner();
    error NotGovernor();
    error RedemptionsLocked();
    error InvalidGovernor();

    // ── Init Params ──
    struct InitParams {
        address asset;
        string name;
        string symbol;
        address owner;
        address executorImpl;
        bool openDeposits;
        address agentRegistry;
        address governor;
        uint256 managementFeeBps;
    }

    // ── Per-Agent Config ──
    struct AgentConfig {
        uint256 agentId; // ERC-8004 identity token ID
        address agentAddress; // Agent wallet address (the executor)
        bool active;
    }

    // ── LP Functions ──
    function ragequit(address receiver) external returns (uint256 assets);

    // ── Owner Functions ──
    function executeBatch(BatchExecutorLib.Call[] calldata calls) external;

    // ── Depositor Whitelist ──
    function approveDepositor(address depositor) external;
    function removeDepositor(address depositor) external;
    function approveDepositors(address[] calldata depositors) external;
    function isApprovedDepositor(address depositor) external view returns (bool);
    function getApprovedDepositors() external view returns (address[] memory);
    function setOpenDeposits(bool open) external;
    function openDeposits() external view returns (bool);

    // ── Views ──
    function getAgentConfig(address agentAddress) external view returns (AgentConfig memory);
    function getAgentCount() external view returns (uint256);
    function isAgent(address agentAddress) external view returns (bool);
    function getExecutorImpl() external view returns (address);
    function totalDeposited() external view returns (uint256);
    function getAgentAddresses() external view returns (address[] memory);

    // ── Governor ──
    function executeGovernorBatch(BatchExecutorLib.Call[] calldata calls) external;
    function transferPerformanceFee(address asset, address to, uint256 amount) external;
    function governor() external view returns (address);
    function redemptionsLocked() external view returns (bool);
    function managementFeeBps() external view returns (uint256);

    // ── Admin (syndicate creator) ──
    function registerAgent(uint256 agentId, address agentAddress) external;
    function removeAgent(address agentAddress) external;
    function pause() external;
    function unpause() external;

    // ── Events ──
    event AgentRegistered(uint256 indexed agentId, address indexed agentAddress);
    event AgentRemoved(address indexed agentAddress);
    event Ragequit(address indexed lp, uint256 shares, uint256 assets);
    event DepositorApproved(address indexed depositor);
    event DepositorRemoved(address indexed depositor);
    event OpenDepositsUpdated(bool open);
}
