// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ISyndicateFactory {
    // ── Events (Task 26) ──
    event OwnerRotated(address indexed vault, address indexed newOwner);

    // ── Errors (Task 26) ──
    error VaultStillStaked();

    // ── Errors (V-H3) ──
    error VaultImplMismatch();

    // ── Errors (V-M7) ──
    error InvalidSyndicateConfig();

    // ── Views ──
    function governor() external view returns (address);
    function vaultImpl() external view returns (address);
    function vaultToSyndicate(address vault) external view returns (uint256);
    function guardianRegistry() external view returns (address);

    // ── Admin ──
    function rotateOwner(address vault, address newOwner) external;
}
