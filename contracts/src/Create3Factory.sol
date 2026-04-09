// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Create3} from "./Create3.sol";

/// @notice Thin wrapper around Create3 library — deployed once, then called externally.
///         This avoids Foundry splitting create2 into 2 broadcast transactions.
///         Each deploy() call is a single transaction: caller → factory → create2 + create.
contract Create3Factory {
    /// @notice Deploy a contract via CREATE3. Only the factory owner can call.
    /// @param salt Unique salt for deterministic addressing
    /// @param creationCode Full creation code (type(X).creationCode + constructor args)
    /// @return deployed The address of the deployed contract
    function deploy(bytes32 salt, bytes memory creationCode) external returns (address deployed) {
        return Create3.deploy(salt, creationCode);
    }

    /// @notice Predict the deployed address for a given salt
    function addressOf(bytes32 salt) external view returns (address) {
        return Create3.addressOf(address(this), salt);
    }
}
