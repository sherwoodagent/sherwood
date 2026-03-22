// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IL2Registrar} from "../../src/interfaces/IL2Registrar.sol";

/// @notice Mock Durin L2 Registrar for unit tests.
///         Tracks registered labels → owners and enforces uniqueness + min-length.
contract MockL2Registrar is IL2Registrar {
    mapping(bytes32 => address) private _owners;
    mapping(bytes32 => bool) private _taken;

    /// @notice Register a subdomain label to an owner
    function register(string calldata label, address owner) external override {
        bytes32 key = keccak256(bytes(label));
        require(!_taken[key], "Already registered");
        require(bytes(label).length >= 3, "Label too short");
        _taken[key] = true;
        _owners[key] = owner;
    }

    /// @notice Check if a label is available
    function available(string calldata label) external view override returns (bool) {
        if (bytes(label).length < 3) return false;
        return !_taken[keccak256(bytes(label))];
    }

    /// @notice Get the current owner of a registered label
    function ownerOf(string calldata label) external view override returns (address) {
        return _owners[keccak256(bytes(label))];
    }

    // ── Test helpers ──

    /// @notice Alias for ownerOf (backwards compat with existing tests)
    function getOwner(string calldata label) external view returns (address) {
        return _owners[keccak256(bytes(label))];
    }

    /// @notice Check if a label has been registered (for test assertions)
    function isRegistered(string calldata label) external view returns (bool) {
        return _taken[keccak256(bytes(label))];
    }
}
