// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SyndicateVault} from "./SyndicateVault.sol";
import {ISyndicateVault} from "./interfaces/ISyndicateVault.sol";

/**
 * @title SyndicateFactory
 * @notice Deploys new syndicate vaults as UUPS proxies. One tx = one syndicate.
 *
 *   All syndicates share the same executor lib (stateless, called via delegatecall)
 *   and vault implementation. Each vault proxy has its own storage: positions,
 *   agent registry, allowlist, and caps.
 */
contract SyndicateFactory {
    struct SyndicateConfig {
        string metadataURI; // ipfs://Qm... (name, description, strategies)
        IERC20 asset; // Deposit asset (e.g., USDC)
        string name; // Vault token name
        string symbol; // Vault token symbol
        ISyndicateVault.SyndicateCaps caps; // Syndicate-wide limits
        address[] initialTargets; // Protocol addresses to allowlist
    }

    struct Syndicate {
        uint256 id;
        address vault; // ERC-4626 vault (proxy)
        address creator;
        string metadataURI; // ipfs://... via Pinata
        uint256 createdAt;
        bool active;
    }

    /// @notice Shared executor lib (deployed once, stateless)
    address public immutable executorImpl;

    /// @notice Shared vault implementation (for UUPS proxies)
    address public immutable vaultImpl;

    /// @notice All syndicates
    mapping(uint256 => Syndicate) public syndicates;
    uint256 public syndicateCount;

    /// @notice Vault address → syndicate ID
    mapping(address => uint256) public vaultToSyndicate;

    event SyndicateCreated(uint256 indexed id, address indexed vault, address indexed creator, string metadataURI);
    event MetadataUpdated(uint256 indexed id, string metadataURI);
    event SyndicateDeactivated(uint256 indexed id);

    constructor(address executorImpl_, address vaultImpl_) {
        require(executorImpl_ != address(0), "Invalid executor impl");
        require(vaultImpl_ != address(0), "Invalid vault impl");
        executorImpl = executorImpl_;
        vaultImpl = vaultImpl_;
    }

    /// @notice Create a new syndicate — deploys vault proxy, registers everything
    /// @param config Syndicate configuration
    /// @return syndicateId The new syndicate's ID
    /// @return vault The deployed vault proxy address
    function createSyndicate(SyndicateConfig calldata config) external returns (uint256 syndicateId, address vault) {
        syndicateId = ++syndicateCount;

        // Deploy vault as UUPS proxy
        bytes memory initData = abi.encodeCall(
            SyndicateVault.initialize,
            (
                config.asset,
                config.name,
                config.symbol,
                msg.sender, // owner = creator
                config.caps,
                executorImpl,
                config.initialTargets
            )
        );

        vault = address(new ERC1967Proxy(vaultImpl, initData));

        syndicates[syndicateId] = Syndicate({
            id: syndicateId,
            vault: vault,
            creator: msg.sender,
            metadataURI: config.metadataURI,
            createdAt: block.timestamp,
            active: true
        });

        vaultToSyndicate[vault] = syndicateId;

        emit SyndicateCreated(syndicateId, vault, msg.sender, config.metadataURI);
    }

    /// @notice Update syndicate metadata (creator only)
    function updateMetadata(uint256 syndicateId, string calldata metadataURI) external {
        Syndicate storage s = syndicates[syndicateId];
        require(s.creator == msg.sender, "Not creator");
        s.metadataURI = metadataURI;
        emit MetadataUpdated(syndicateId, metadataURI);
    }

    /// @notice Deactivate a syndicate (creator only)
    function deactivate(uint256 syndicateId) external {
        Syndicate storage s = syndicates[syndicateId];
        require(s.creator == msg.sender, "Not creator");
        s.active = false;
        emit SyndicateDeactivated(syndicateId);
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
