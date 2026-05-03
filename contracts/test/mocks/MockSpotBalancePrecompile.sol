// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal mock for HyperCore spot balance precompile (0x...0801).
/// Always returns a successful abi-encoded (total, hold, entryNtl).
contract MockSpotBalancePrecompile {
    uint64 public total;
    uint64 public hold;
    uint64 public entryNtl;

    function setSpot(uint64 total_, uint64 hold_, uint64 entryNtl_) external {
        total = total_;
        hold = hold_;
        entryNtl = entryNtl_;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(total, hold, entryNtl);
    }
}
