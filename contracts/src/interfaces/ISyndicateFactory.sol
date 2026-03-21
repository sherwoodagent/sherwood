// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ISyndicateFactory {
    function governor() external view returns (address);
    function vaultImpl() external view returns (address);
    function vaultToSyndicate(address vault) external view returns (uint256);
}
