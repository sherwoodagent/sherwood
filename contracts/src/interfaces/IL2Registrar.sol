// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IL2Registrar
/// @notice Minimal interface for the Durin L2 Registrar (ENS subnames on L2).
///         The registrar handles setAddr + createSubnode on the L2 Registry internally.
interface IL2Registrar {
    /// @notice Register a new subdomain. Sets address records and mints subname NFT to `owner`.
    /// @param label The subdomain label (e.g. "alpha-seekers" for alpha-seekers.sherwoodagent.eth)
    /// @param owner The address that will own the subname NFT and be set as the address record
    function register(string calldata label, address owner) external;

    /// @notice Check if a subdomain label is available for registration
    /// @param label The subdomain label to check
    /// @return True if the label is available (not taken and >= 3 chars)
    function available(string calldata label) external view returns (bool);

    /// @notice Get the current owner of a registered subdomain's NFT
    /// @param label The subdomain label to look up
    /// @return The address that owns the subname NFT (typically the vault)
    function ownerOf(string calldata label) external view returns (address);
}
