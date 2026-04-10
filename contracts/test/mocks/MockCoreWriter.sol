// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Mock CoreWriter for testing — deployed at 0x3333...3333 via vm.etch.
///         On real HyperEVM, 0x3333...3333 is a system precompile that processes these events.
///         This mock just emits events and burns gas to simulate the precompile behavior.
contract MockCoreWriter {
    /// @notice Emitted when a raw action is sent to HyperCore
    /// @param user The address that initiated the action
    /// @param data The encoded action data
    event RawAction(address indexed user, bytes data);

    /// @notice Sends a raw encoded action to HyperCore by emitting a RawAction event
    /// @param data The fully encoded action data (version byte + action ID + ABI-encoded
    /// parameters)
    function sendRawAction(bytes calldata data) external {
        // Spends ~20k gas
        for (uint256 i = 0; i < 400; i++) {}
        emit RawAction(msg.sender, data);
    }
}
