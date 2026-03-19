// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SyndicateVault} from "./SyndicateVault.sol";
import {ISyndicateVault} from "./interfaces/ISyndicateVault.sol";
import {ISyndicateGovernor} from "./interfaces/ISyndicateGovernor.sol";
import {IL2Registrar} from "./interfaces/IL2Registrar.sol";

/**
 * @title SyndicateFactory
 * @notice Deploys new syndicate vaults as UUPS proxies. One tx = one syndicate.
 *
 *   All syndicates share the same executor lib (stateless, called via delegatecall)
 *   and vault implementation. Each vault proxy has its own storage: positions,
 *   agent registry, and depositor whitelist.
 *
 *   ENS subnames are registered atomically via Durin L2 Registrar, so each
 *   syndicate gets a <subdomain>.sherwoodagent.eth name resolving to its vault.
 */
contract SyndicateFactory {
    // ── Errors ──
    error InvalidExecutorImpl();
    error InvalidVaultImpl();
    error InvalidENSRegistrar();
    error InvalidAgentRegistry();
    error NotAgentOwner();
    error SubdomainTooShort();
    error SubdomainTaken();
    error NotCreator();
    error InvalidGovernor();

    struct SyndicateConfig {
        string metadataURI; // ipfs://Qm... (name, description, strategies)
        IERC20 asset; // Deposit asset (e.g., USDC)
        string name; // Vault token name
        string symbol; // Vault token symbol
        bool openDeposits; // If true, anyone can deposit. If false, depositor whitelist enforced.
        string subdomain; // ENS subdomain label (e.g. "alpha-seekers")
    }

    struct Syndicate {
        uint256 id;
        address vault; // ERC-4626 vault (proxy)
        address creator;
        string metadataURI; // ipfs://... via Pinata
        uint256 createdAt;
        bool active;
        string subdomain; // ENS subdomain registered
    }

    /// @notice Shared executor lib (deployed once, stateless)
    address public immutable executorImpl;

    /// @notice Shared vault implementation (for UUPS proxies)
    address public immutable vaultImpl;

    /// @notice Durin L2 Registrar for ENS subnames
    IL2Registrar public immutable ensRegistrar;

    /// @notice ERC-8004 agent identity registry (ERC-721)
    IERC721 public immutable agentRegistry;

    /// @notice Shared governor contract
    address public immutable governor;

    /// @notice Management fee for vault owners: 0.5% of strategy profits
    uint256 public constant MANAGEMENT_FEE_BPS = 50;

    /// @notice All syndicates
    mapping(uint256 => Syndicate) public syndicates;
    uint256 public syndicateCount;

    /// @notice Vault address → syndicate ID
    mapping(address => uint256) public vaultToSyndicate;

    /// @notice ENS subdomain → syndicate ID
    mapping(string => uint256) public subdomainToSyndicate;

    event SyndicateCreated(
        uint256 indexed id, address indexed vault, address indexed creator, string metadataURI, string subdomain
    );
    event MetadataUpdated(uint256 indexed id, string metadataURI);
    event SyndicateDeactivated(uint256 indexed id);

    constructor(
        address executorImpl_,
        address vaultImpl_,
        address ensRegistrar_,
        address agentRegistry_,
        address governor_
    ) {
        if (executorImpl_ == address(0)) revert InvalidExecutorImpl();
        if (vaultImpl_ == address(0)) revert InvalidVaultImpl();
        if (governor_ == address(0)) revert InvalidGovernor();
        // ensRegistrar_ and agentRegistry_ may be address(0) on chains
        // without ENS/Durin or ERC-8004 (e.g. Robinhood L2)
        executorImpl = executorImpl_;
        vaultImpl = vaultImpl_;
        ensRegistrar = IL2Registrar(ensRegistrar_);
        agentRegistry = IERC721(agentRegistry_);
        governor = governor_;
    }

    /// @notice Create a new syndicate — deploys vault proxy, registers ENS subname, stores everything
    /// @param creatorAgentId ERC-8004 agent ID of the creator (must be owned by msg.sender)
    /// @param config Syndicate configuration
    /// @return syndicateId The new syndicate's ID
    /// @return vault The deployed vault proxy address
    function createSyndicate(uint256 creatorAgentId, SyndicateConfig calldata config)
        external
        returns (uint256 syndicateId, address vault)
    {
        // Verify ERC-8004 identity (skipped on chains without agent registry)
        if (address(agentRegistry) != address(0)) {
            if (agentRegistry.ownerOf(creatorAgentId) != msg.sender) revert NotAgentOwner();
        }

        // Validate subdomain
        if (bytes(config.subdomain).length < 3) revert SubdomainTooShort();
        if (subdomainToSyndicate[config.subdomain] != 0) revert SubdomainTaken();

        syndicateId = ++syndicateCount;

        // Deploy vault as UUPS proxy
        ISyndicateVault.InitParams memory initParams = ISyndicateVault.InitParams({
            asset: address(config.asset),
            name: config.name,
            symbol: config.symbol,
            owner: msg.sender,
            executorImpl: executorImpl,
            openDeposits: config.openDeposits,
            agentRegistry: address(agentRegistry),
            governor: governor,
            managementFeeBps: MANAGEMENT_FEE_BPS
        });
        bytes memory initData = abi.encodeCall(SyndicateVault.initialize, (initParams));

        vault = address(new ERC1967Proxy(vaultImpl, initData));

        // Register vault on governor
        ISyndicateGovernor(governor).addVault(vault);

        // Register ENS subname (skipped on chains without Durin L2 Registrar)
        if (address(ensRegistrar) != address(0)) {
            ensRegistrar.register(config.subdomain, vault);
        }

        syndicates[syndicateId] = Syndicate({
            id: syndicateId,
            vault: vault,
            creator: msg.sender,
            metadataURI: config.metadataURI,
            createdAt: block.timestamp,
            active: true,
            subdomain: config.subdomain
        });

        vaultToSyndicate[vault] = syndicateId;
        subdomainToSyndicate[config.subdomain] = syndicateId;

        emit SyndicateCreated(syndicateId, vault, msg.sender, config.metadataURI, config.subdomain);
    }

    /// @notice Update syndicate metadata (creator only)
    function updateMetadata(uint256 syndicateId, string calldata metadataURI) external {
        Syndicate storage s = syndicates[syndicateId];
        if (s.creator != msg.sender) revert NotCreator();
        s.metadataURI = metadataURI;
        emit MetadataUpdated(syndicateId, metadataURI);
    }

    /// @notice Deactivate a syndicate (creator only)
    function deactivate(uint256 syndicateId) external {
        Syndicate storage s = syndicates[syndicateId];
        if (s.creator != msg.sender) revert NotCreator();
        s.active = false;
        emit SyndicateDeactivated(syndicateId);
    }

    /// @notice Check if a subdomain is available for registration
    function isSubdomainAvailable(string calldata subdomain) external view returns (bool) {
        if (address(ensRegistrar) == address(0)) {
            return subdomainToSyndicate[subdomain] == 0;
        }
        return subdomainToSyndicate[subdomain] == 0 && ensRegistrar.available(subdomain);
    }

    /// @notice Get all active syndicates (for dashboard)
    function getActiveSyndicates() external view returns (Syndicate[] memory) {
        uint256 count = 0;
        for (uint256 i = 1; i <= syndicateCount; i++) {
            if (syndicates[i].active) count++;
        }

        Syndicate[] memory result = new Syndicate[](count);
        uint256 idx = 0;
        for (uint256 i = 1; i <= syndicateCount; i++) {
            if (syndicates[i].active) {
                result[idx++] = syndicates[i];
            }
        }
        return result;
    }
}
