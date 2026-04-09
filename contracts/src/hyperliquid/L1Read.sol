// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// ============ Structs ============

/// @notice A user's perpetual futures position on HyperCore.
/// @param szi Signed position size. Positive for long, negative for short.
///        To convert to a float, divide by 10^szDecimals (from PerpAssetInfo).
/// @param entryNtl Entry notional value of the position.
/// @param isolatedRawUsd Raw USD margin allocated to the position (only meaningful when isIsolated
/// is true). @param leverage Leverage multiplier applied to the position.
/// @param isIsolated True if the position uses isolated margin; false for cross margin.
struct Position {
    int64 szi;
    uint64 entryNtl;
    int64 isolatedRawUsd;
    uint32 leverage;
    bool isIsolated;
}

/// @notice A user's spot token balance on HyperCore.
/// @param total Complete balance including available and held amounts.
/// @param hold Amount currently locked in open orders.
/// @param entryNtl Entry notional value of the balance, used for PnL tracking.
struct SpotBalance {
    uint64 total;
    uint64 hold;
    uint64 entryNtl;
}

/// @notice A user's equity in a HyperCore vault.
/// @param equity The user's equity share in the vault.
/// @param lockedUntilTimestamp Unix timestamp until which the equity is locked and cannot be
/// withdrawn.
struct UserVaultEquity {
    uint64 equity;
    uint64 lockedUntilTimestamp;
}

/// @notice Amount a user can withdraw from HyperCore without affecting open positions.
/// @param withdrawable The withdrawable amount.
struct Withdrawable {
    uint64 withdrawable;
}

/// @notice A single staking delegation from a user to a validator.
/// @param validator Address of the validator the stake is delegated to.
/// @param amount Amount of HYPE delegated.
/// @param lockedUntilTimestamp Unix timestamp until which the delegation is locked (unbonding
/// period).
struct Delegation {
    address validator;
    uint64 amount;
    uint64 lockedUntilTimestamp;
}

/// @notice Aggregated staking summary for a delegator across all validators.
/// @param delegated Total amount currently delegated and earning rewards.
/// @param undelegated Total amount that has been undelegated (may still be in unbonding period).
/// @param totalPendingWithdrawal Total amount pending withdrawal (currently in unbonding period).
/// @param nPendingWithdrawals Number of pending withdrawal transactions (max 5 per address).
struct DelegatorSummary {
    uint64 delegated;
    uint64 undelegated;
    uint64 totalPendingWithdrawal;
    uint64 nPendingWithdrawals;
}

/// @notice Metadata for a perpetual futures asset on HyperCore.
/// @param coin Ticker symbol of the asset (e.g. "ETH", "BTC").
/// @param marginTableId Identifier for the margin tier table governing position limits and leverage
/// tiers. @param szDecimals Number of decimals for size. The minimum order increment is
/// 10^(-szDecimals).
/// @param maxLeverage Maximum leverage allowed for this asset (range [1, 50]).
/// @param onlyIsolated True if the asset can only be traded in isolated margin mode (margin cannot
/// be removed; it is proportionally returned as the position is closed).
struct PerpAssetInfo {
    string coin;
    uint32 marginTableId;
    uint8 szDecimals;
    uint8 maxLeverage;
    bool onlyIsolated;
}

/// @notice Metadata for a spot trading pair on HyperCore.
/// @param name Name of the spot pair (e.g. "ETH/USDC").
/// @param tokens The two token indices that make up the pair: [base, quote].
struct SpotInfo {
    string name;
    uint64[2] tokens;
}

/// @notice Metadata for a HIP-1 native token.
/// @param name Token name / ticker.
/// @param spots Indices of spot pairs that include this token.
/// @param deployerTradingFeeShare Percentage (in deployer-set units) of non-USDC spot fees directed
/// to the deployer. Can only be lowered after initial deployment; unallocated portion is burned.
/// @param deployer Address of the token deployer on HyperCore.
/// @param evmContract Address of the token's ERC-20 contract on HyperEVM (address(0) if none).
/// @param szDecimals Minimum tradable decimals on spot order books. Lot size = 10^(weiDecimals -
/// szDecimals). @param weiDecimals Conversion rate from the minimal integer unit to a
/// human-readable float
///        (analogous to ERC-20 decimals). Constraint: szDecimals + 5 <= weiDecimals.
/// @param evmExtraWeiDecimals Additional wei decimals on HyperEVM beyond the HyperCore weiDecimals.
///        The ERC-20 on HyperEVM has (weiDecimals + evmExtraWeiDecimals) decimals.
struct TokenInfo {
    string name;
    uint64[] spots;
    uint64 deployerTradingFeeShare;
    address deployer;
    address evmContract;
    uint8 szDecimals;
    uint8 weiDecimals;
    int8 evmExtraWeiDecimals;
}

/// @notice A user address and associated balance, used within TokenSupply for non-circulating
/// holders. @param user Address of the holder.
/// @param balance The holder's balance.
struct UserBalance {
    address user;
    uint64 balance;
}

/// @notice Supply breakdown for a HIP-1 native token.
/// @param maxSupply Maximum and initial supply. May decrease over time due to spot fee burns.
/// @param totalSupply Current total supply (maxSupply minus any burned tokens).
/// @param circulatingSupply Tokens in active circulation (totalSupply minus non-circulating
/// balances and future emissions).
/// @param futureEmissions Tokens reserved for future emission that are not yet circulating.
/// @param nonCirculatingUserBalances Addresses and balances of holders whose tokens are excluded
///        from circulating supply.
struct TokenSupply {
    uint64 maxSupply;
    uint64 totalSupply;
    uint64 circulatingSupply;
    uint64 futureEmissions;
    UserBalance[] nonCirculatingUserBalances;
}

/// @notice Best bid and offer for an asset on HyperCore.
/// @param bid Best (highest) bid price.
/// @param ask Best (lowest) ask price.
struct Bbo {
    uint64 bid;
    uint64 ask;
}

/// @notice Margin summary for a user's account on a perp dex.
/// @param accountValue Total account equity including unrealized PnL.
/// @param marginUsed Total margin deployed across all positions.
/// @param ntlPos Total notional position value across all open positions.
/// @param rawUsd Raw USD balance before leverage adjustments.
struct AccountMarginSummary {
    int64 accountValue;
    uint64 marginUsed;
    uint64 ntlPos;
    int64 rawUsd;
}

/// @notice Whether a user account is activated on HyperCore.
/// @param exists True if the user has an activated HyperCore account.
struct CoreUserExists {
    bool exists;
}

/// @notice Cost basis and current value for a borrow or supply position.
/// @param basis Original cost basis of the position.
/// @param value Current value of the position (including accrued interest).
struct BasisAndValue {
    uint64 basis;
    uint64 value;
}

/// @notice A user's borrow/lend state for a specific token.
/// @param borrow The user's borrow position (basis and current value with accrued interest).
/// @param supply The user's supply/lending position (basis and current value with accrued
/// interest).
struct BorrowLendUserTokenState {
    BasisAndValue borrow;
    BasisAndValue supply;
}

/// @notice Global borrow/lend reserve state for a token.
/// @param borrowYearlyRateBps Annual borrow interest rate in basis points (1 bp = 0.01%).
/// @param supplyYearlyRateBps Annual supply/lending interest rate in basis points.
/// @param balance Total token balance held in the reserve.
/// @param utilizationBps Pool utilization rate in basis points (totalBorrowed / totalSupplied).
/// @param oraclePx Oracle price of the token.
/// @param ltvBps Loan-to-value ratio in basis points.
/// @param totalSupplied Total amount of the token supplied to the lending pool.
/// @param totalBorrowed Total amount of the token borrowed from the pool.
struct BorrowLendReserveState {
    uint64 borrowYearlyRateBps;
    uint64 supplyYearlyRateBps;
    uint64 balance;
    uint64 utilizationBps;
    uint64 oraclePx;
    uint64 ltvBps;
    uint64 totalSupplied;
    uint64 totalBorrowed;
}

// ============ Errors ============

error PositionPrecompileCallFailed();
error Position2PrecompileCallFailed();
error SpotBalancePrecompileCallFailed();
error VaultEquityPrecompileCallFailed();
error WithdrawablePrecompileCallFailed();
error DelegationsPrecompileCallFailed();
error DelegatorSummaryPrecompileCallFailed();
error MarkPxPrecompileCallFailed();
error OraclePxPrecompileCallFailed();
error SpotPxPrecompileCallFailed();
error L1BlockNumberPrecompileCallFailed();
error PerpAssetInfoPrecompileCallFailed();
error SpotInfoPrecompileCallFailed();
error TokenInfoPrecompileCallFailed();
error TokenSupplyPrecompileCallFailed();
error BboPrecompileCallFailed();
error AccountMarginSummaryPrecompileCallFailed();
error CoreUserExistsPrecompileCallFailed();
error BorrowLendUserStatePrecompileCallFailed();
error BorrowLendReserveStatePrecompileCallFailed();

// ============ Library ============

/// @title L1Read
/// @notice Library for reading HyperCore L1 state via precompile staticcalls.
/// @dev Values are guaranteed to match the latest HyperCore state at the time the EVM block is
/// constructed. Precompile gas cost formula: 2000 + 65 * (input_len + output_len).
///      Invalid inputs (e.g. non-existent assets or vaults) cause the precompile to revert and
/// consume all gas passed into the call frame. Gas caps (~20% above formula) are applied where
/// output size
///      is fixed to limit this. Functions with dynamic-length outputs are left uncapped.
///      Each query has a reverting version (e.g. `position`) that reverts with a custom error on
///      precompile failure, and a non-reverting `try` version (e.g. `tryPosition`) that returns
///      a `(result, bool success)` tuple. On failure the result is zero-initialized.
library L1Read {
    address constant POSITION_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000800;
    address constant SPOT_BALANCE_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000801;
    address constant VAULT_EQUITY_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000802;
    address constant WITHDRAWABLE_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000803;
    address constant DELEGATIONS_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000804;
    address constant DELEGATOR_SUMMARY_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000805;
    address constant MARK_PX_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000806;
    address constant ORACLE_PX_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000807;
    address constant SPOT_PX_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000808;
    address constant L1_BLOCK_NUMBER_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000809;
    address constant PERP_ASSET_INFO_PRECOMPILE_ADDRESS = 0x000000000000000000000000000000000000080a;
    address constant SPOT_INFO_PRECOMPILE_ADDRESS = 0x000000000000000000000000000000000000080b;
    address constant TOKEN_INFO_PRECOMPILE_ADDRESS = 0x000000000000000000000000000000000000080C;
    address constant TOKEN_SUPPLY_PRECOMPILE_ADDRESS = 0x000000000000000000000000000000000000080D;
    address constant BBO_PRECOMPILE_ADDRESS = 0x000000000000000000000000000000000000080e;
    address constant ACCOUNT_MARGIN_SUMMARY_PRECOMPILE_ADDRESS = 0x000000000000000000000000000000000000080F;
    address constant CORE_USER_EXISTS_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000810;
    address constant BORROW_LEND_USER_STATE_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000811;
    address constant BORROW_LEND_RESERVE_STATE_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000812;
    address constant POSITION2_PRECOMPILE_ADDRESS = 0x0000000000000000000000000000000000000813;

    // Max gas forwarded to precompile staticcalls.
    // Precompile gas cost formula: 2000 + 65 * (input_len + output_len)
    // Caps are ~20% above formula, rounded up. Prevents invalid inputs from
    // consuming all remaining gas in the call frame.
    // Functions with dynamic-length outputs are left uncapped.
    uint256 constant POSITION_GAS = 20_000; // 2000 + 65*(64+160) = 16560
    uint256 constant SPOT_BALANCE_GAS = 15_000; // 2000 + 65*(64+96)  = 12400
    uint256 constant VAULT_EQUITY_GAS = 12_500; // 2000 + 65*(64+64)  = 10320
    uint256 constant WITHDRAWABLE_GAS = 7500; // 2000 + 65*(32+32)  = 6160
    uint256 constant DELEGATOR_SUMMARY_GAS = 15_000; // 2000 + 65*(32+128) = 12400
    uint256 constant MARK_PX_GAS = 7500; // 2000 + 65*(32+32)  = 6160
    uint256 constant ORACLE_PX_GAS = 7500; // 2000 + 65*(32+32)  = 6160
    uint256 constant SPOT_PX_GAS = 7500; // 2000 + 65*(32+32)  = 6160
    uint256 constant L1_BLOCK_NUMBER_GAS = 5000; // 2000 + 65*(0+32)   = 4080
    uint256 constant BBO_GAS = 10_000; // 2000 + 65*(32+64)  = 8240
    uint256 constant ACCOUNT_MARGIN_SUMMARY_GAS = 17_500; // 2000 + 65*(64+128) = 14480
    uint256 constant CORE_USER_EXISTS_GAS = 7500; // 2000 + 65*(32+32)  = 6160
    uint256 constant BORROW_LEND_USER_STATE_GAS = 17_500; // 2000 + 65*(64+128) = 14480
    uint256 constant BORROW_LEND_RESERVE_STATE_GAS = 25_000; // 2000 + 65*(32+256) = 20720

    // ============ Position (uint16 perp) ============

    /// @notice Query a user's perpetual position by 16-bit perp index.
    /// @param user Address of the user.
    /// @param perp 16-bit perpetual asset index.
    /// @return The user's position for the given perp.
    function position(address user, uint16 perp) internal view returns (Position memory) {
        (Position memory result, bool success) = tryPosition(user, perp);
        require(success, PositionPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `position`. Returns success=false if the precompile call
    /// fails.
    function tryPosition(address user, uint16 perp) internal view returns (Position memory result, bool success) {
        (bool _success, bytes memory _result) =
            POSITION_PRECOMPILE_ADDRESS.staticcall{gas: POSITION_GAS}(abi.encode(user, perp));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (Position)), true);
    }

    // ============ Position2 (uint32 perp) ============

    /// @notice Query a user's perpetual position by 32-bit perp index.
    /// @dev Supports the extended perp index range (> uint16). Returns the same Position struct as
    /// `position`. @param user Address of the user.
    /// @param perp 32-bit perpetual asset index.
    /// @return The user's position for the given perp.
    function position2(address user, uint32 perp) internal view returns (Position memory) {
        (Position memory result, bool success) = tryPosition2(user, perp);
        require(success, Position2PrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `position2`. Returns success=false if the precompile call
    /// fails.
    function tryPosition2(address user, uint32 perp) internal view returns (Position memory result, bool success) {
        (bool _success, bytes memory _result) =
            POSITION2_PRECOMPILE_ADDRESS.staticcall{gas: POSITION_GAS}(abi.encode(user, perp));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (Position)), true);
    }

    // ============ Spot Balance ============

    /// @notice Query a user's spot token balance.
    /// @param user Address of the user.
    /// @param token Token index on HyperCore.
    /// @return The user's spot balance for the given token.
    function spotBalance(address user, uint64 token) internal view returns (SpotBalance memory) {
        (SpotBalance memory result, bool success) = trySpotBalance(user, token);
        require(success, SpotBalancePrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `spotBalance`. Returns success=false if the precompile
    /// call fails.
    function trySpotBalance(address user, uint64 token)
        internal
        view
        returns (SpotBalance memory result, bool success)
    {
        (bool _success, bytes memory _result) = SPOT_BALANCE_PRECOMPILE_ADDRESS.staticcall{gas: SPOT_BALANCE_GAS}(
            abi.encode(user, token)
        );
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (SpotBalance)), true);
    }

    // ============ User Vault Equity ============

    /// @notice Query a user's equity in a vault.
    /// @param user Address of the user.
    /// @param vault Address of the vault.
    /// @return The user's equity and lock status in the vault.
    function userVaultEquity(address user, address vault) internal view returns (UserVaultEquity memory) {
        (UserVaultEquity memory result, bool success) = tryUserVaultEquity(user, vault);
        require(success, VaultEquityPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `userVaultEquity`. Returns success=false if the
    /// precompile call fails.
    function tryUserVaultEquity(address user, address vault)
        internal
        view
        returns (UserVaultEquity memory result, bool success)
    {
        (bool _success, bytes memory _result) =
            VAULT_EQUITY_PRECOMPILE_ADDRESS.staticcall{gas: VAULT_EQUITY_GAS}(abi.encode(user, vault));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (UserVaultEquity)), true);
    }

    // ============ Withdrawable ============

    /// @notice Query the amount a user can withdraw from HyperCore.
    /// @param user Address of the user.
    /// @return The withdrawable amount.
    function withdrawable(address user) internal view returns (Withdrawable memory) {
        (Withdrawable memory result, bool success) = tryWithdrawable(user);
        require(success, WithdrawablePrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `withdrawable`. Returns success=false if the precompile
    /// call fails.
    function tryWithdrawable(address user) internal view returns (Withdrawable memory result, bool success) {
        (bool _success, bytes memory _result) =
            WITHDRAWABLE_PRECOMPILE_ADDRESS.staticcall{gas: WITHDRAWABLE_GAS}(abi.encode(user));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (Withdrawable)), true);
    }

    // ============ Delegations ============

    /// @notice Query all staking delegations for a user.
    /// @dev No gas cap: output is dynamic-length (Delegation[]).
    /// @param user Address of the delegator.
    /// @return Array of the user's active delegations to validators.
    function delegations(address user) internal view returns (Delegation[] memory) {
        (Delegation[] memory result, bool success) = tryDelegations(user);
        require(success, DelegationsPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `delegations`. Returns success=false if the precompile
    /// call fails.
    function tryDelegations(address user) internal view returns (Delegation[] memory result, bool success) {
        (bool _success, bytes memory _result) = DELEGATIONS_PRECOMPILE_ADDRESS.staticcall(abi.encode(user));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (Delegation[])), true);
    }

    // ============ Delegator Summary ============

    /// @notice Query an aggregated staking summary for a delegator.
    /// @param user Address of the delegator.
    /// @return Aggregated delegation totals and pending withdrawal counts.
    function delegatorSummary(address user) internal view returns (DelegatorSummary memory) {
        (DelegatorSummary memory result, bool success) = tryDelegatorSummary(user);
        require(success, DelegatorSummaryPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `delegatorSummary`. Returns success=false if the
    /// precompile call fails.
    function tryDelegatorSummary(address user) internal view returns (DelegatorSummary memory result, bool success) {
        (bool _success, bytes memory _result) =
            DELEGATOR_SUMMARY_PRECOMPILE_ADDRESS.staticcall{gas: DELEGATOR_SUMMARY_GAS}(abi.encode(user));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (DelegatorSummary)), true);
    }

    // ============ Mark Price ============

    /// @notice Query the mark price of a perpetual asset.
    /// @dev To convert to a float: divide by 10^(6 - szDecimals).
    /// @param index Perpetual asset index.
    /// @return Mark price as a fixed-point integer.
    function markPx(uint32 index) internal view returns (uint64) {
        (uint64 result, bool success) = tryMarkPx(index);
        require(success, MarkPxPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `markPx`. Returns success=false if the precompile call
    /// fails.
    function tryMarkPx(uint32 index) internal view returns (uint64 result, bool success) {
        (bool _success, bytes memory _result) =
            MARK_PX_PRECOMPILE_ADDRESS.staticcall{gas: MARK_PX_GAS}(abi.encode(index));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (uint64)), true);
    }

    // ============ Oracle Price ============

    /// @notice Query the oracle price of a perpetual asset.
    /// @dev To convert to a float: divide by 10^(6 - szDecimals).
    /// @param index Perpetual asset index.
    /// @return Oracle price as a fixed-point integer.
    function oraclePx(uint32 index) internal view returns (uint64) {
        (uint64 result, bool success) = tryOraclePx(index);
        require(success, OraclePxPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `oraclePx`. Returns success=false if the precompile call
    /// fails.
    function tryOraclePx(uint32 index) internal view returns (uint64 result, bool success) {
        (bool _success, bytes memory _result) =
            ORACLE_PX_PRECOMPILE_ADDRESS.staticcall{gas: ORACLE_PX_GAS}(abi.encode(index));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (uint64)), true);
    }

    // ============ Spot Price ============

    /// @notice Query the spot price of a token.
    /// @dev To convert to a float: divide by 10^(8 - base asset szDecimals).
    /// @param index Spot token index.
    /// @return Spot price as a fixed-point integer.
    function spotPx(uint32 index) internal view returns (uint64) {
        (uint64 result, bool success) = trySpotPx(index);
        require(success, SpotPxPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `spotPx`. Returns success=false if the precompile call
    /// fails.
    function trySpotPx(uint32 index) internal view returns (uint64 result, bool success) {
        (bool _success, bytes memory _result) =
            SPOT_PX_PRECOMPILE_ADDRESS.staticcall{gas: SPOT_PX_GAS}(abi.encode(index));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (uint64)), true);
    }

    // ============ L1 Block Number ============

    /// @notice Query the latest L1 block number seen by HyperCore.
    /// @return The L1 block number.
    function l1BlockNumber() internal view returns (uint64) {
        (uint64 result, bool success) = tryL1BlockNumber();
        require(success, L1BlockNumberPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `l1BlockNumber`. Returns success=false if the precompile
    /// call fails.
    function tryL1BlockNumber() internal view returns (uint64 result, bool success) {
        (bool _success, bytes memory _result) =
            L1_BLOCK_NUMBER_PRECOMPILE_ADDRESS.staticcall{gas: L1_BLOCK_NUMBER_GAS}("");
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (uint64)), true);
    }

    // ============ Perp Asset Info ============

    /// @notice Query metadata for a perpetual futures asset.
    /// @dev No gas cap: output contains dynamic-length fields (string).
    /// @param perp Perpetual asset index.
    /// @return Asset metadata including ticker, decimals, leverage limits, and margin mode.
    function perpAssetInfo(uint32 perp) internal view returns (PerpAssetInfo memory) {
        (PerpAssetInfo memory result, bool success) = tryPerpAssetInfo(perp);
        require(success, PerpAssetInfoPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `perpAssetInfo`. Returns success=false if the precompile
    /// call fails.
    function tryPerpAssetInfo(uint32 perp) internal view returns (PerpAssetInfo memory result, bool success) {
        (bool _success, bytes memory _result) = PERP_ASSET_INFO_PRECOMPILE_ADDRESS.staticcall(abi.encode(perp));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (PerpAssetInfo)), true);
    }

    // ============ Spot Info ============

    /// @notice Query metadata for a spot trading pair.
    /// @dev No gas cap: output contains dynamic-length fields (string).
    /// @param spot Spot pair index.
    /// @return Pair name and constituent token indices.
    function spotInfo(uint32 spot) internal view returns (SpotInfo memory) {
        (SpotInfo memory result, bool success) = trySpotInfo(spot);
        require(success, SpotInfoPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `spotInfo`. Returns success=false if the precompile call
    /// fails.
    function trySpotInfo(uint32 spot) internal view returns (SpotInfo memory result, bool success) {
        (bool _success, bytes memory _result) = SPOT_INFO_PRECOMPILE_ADDRESS.staticcall(abi.encode(spot));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (SpotInfo)), true);
    }

    // ============ Token Info ============

    /// @notice Query metadata for a HIP-1 native token.
    /// @dev No gas cap: output contains dynamic-length fields (string, uint64[]).
    /// @param token Token index.
    /// @return Token metadata including name, decimals, deployer info, and associated spot pairs.
    function tokenInfo(uint32 token) internal view returns (TokenInfo memory) {
        (TokenInfo memory result, bool success) = tryTokenInfo(token);
        require(success, TokenInfoPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `tokenInfo`. Returns success=false if the precompile call
    /// fails.
    function tryTokenInfo(uint32 token) internal view returns (TokenInfo memory result, bool success) {
        (bool _success, bytes memory _result) = TOKEN_INFO_PRECOMPILE_ADDRESS.staticcall(abi.encode(token));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (TokenInfo)), true);
    }

    // ============ Token Supply ============

    /// @notice Query supply breakdown for a HIP-1 native token.
    /// @dev No gas cap: output contains dynamic-length fields (UserBalance[]).
    /// @param token Token index.
    /// @return Supply data including max, total, circulating supply, and non-circulating holders.
    function tokenSupply(uint32 token) internal view returns (TokenSupply memory) {
        (TokenSupply memory result, bool success) = tryTokenSupply(token);
        require(success, TokenSupplyPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `tokenSupply`. Returns success=false if the precompile
    /// call fails.
    function tryTokenSupply(uint32 token) internal view returns (TokenSupply memory result, bool success) {
        (bool _success, bytes memory _result) = TOKEN_SUPPLY_PRECOMPILE_ADDRESS.staticcall(abi.encode(token));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (TokenSupply)), true);
    }

    // ============ BBO ============

    /// @notice Query the best bid and offer for an asset.
    /// @param asset Asset index.
    /// @return Best bid and ask prices.
    function bbo(uint32 asset) internal view returns (Bbo memory) {
        (Bbo memory result, bool success) = tryBbo(asset);
        require(success, BboPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `bbo`. Returns success=false if the precompile call
    /// fails.
    function tryBbo(uint32 asset) internal view returns (Bbo memory result, bool success) {
        (bool _success, bytes memory _result) = BBO_PRECOMPILE_ADDRESS.staticcall{gas: BBO_GAS}(abi.encode(asset));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (Bbo)), true);
    }

    // ============ Account Margin Summary ============

    /// @notice Query a user's account margin summary on a perp dex.
    /// @param perpDexIndex The perp dex index (0 for the main perp dex).
    /// @param user Address of the user.
    /// @return Margin summary including account value, margin used, and notional position.
    function accountMarginSummary(uint32 perpDexIndex, address user)
        internal
        view
        returns (AccountMarginSummary memory)
    {
        (AccountMarginSummary memory result, bool success) = tryAccountMarginSummary(perpDexIndex, user);
        require(success, AccountMarginSummaryPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `accountMarginSummary`. Returns success=false if the
    /// precompile call fails.
    function tryAccountMarginSummary(uint32 perpDexIndex, address user)
        internal
        view
        returns (AccountMarginSummary memory result, bool success)
    {
        (bool _success, bytes memory _result) = ACCOUNT_MARGIN_SUMMARY_PRECOMPILE_ADDRESS.staticcall{
            gas: ACCOUNT_MARGIN_SUMMARY_GAS
        }(
            abi.encode(perpDexIndex, user)
        );
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (AccountMarginSummary)), true);
    }

    // ============ Core User Exists ============

    /// @notice Check whether a user account is activated on HyperCore.
    /// @param user Address to check.
    /// @return Whether the user exists on HyperCore.
    function coreUserExists(address user) internal view returns (CoreUserExists memory) {
        (CoreUserExists memory result, bool success) = tryCoreUserExists(user);
        require(success, CoreUserExistsPrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `coreUserExists`. Returns success=false if the
    /// precompile call fails.
    function tryCoreUserExists(address user) internal view returns (CoreUserExists memory result, bool success) {
        (bool _success, bytes memory _result) =
            CORE_USER_EXISTS_PRECOMPILE_ADDRESS.staticcall{gas: CORE_USER_EXISTS_GAS}(abi.encode(user));
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (CoreUserExists)), true);
    }

    // ============ Borrow/Lend User State ============

    /// @notice Query a user's borrow/lend state for a specific token.
    /// @param user Address of the user.
    /// @param token Token index.
    /// @return The user's borrow and supply positions with basis and current value.
    function borrowLendUserState(address user, uint64 token) internal view returns (BorrowLendUserTokenState memory) {
        (BorrowLendUserTokenState memory result, bool success) = tryBorrowLendUserState(user, token);
        require(success, BorrowLendUserStatePrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `borrowLendUserState`. Returns success=false if the
    /// precompile call fails.
    function tryBorrowLendUserState(address user, uint64 token)
        internal
        view
        returns (BorrowLendUserTokenState memory result, bool success)
    {
        (bool _success, bytes memory _result) = BORROW_LEND_USER_STATE_PRECOMPILE_ADDRESS.staticcall{
            gas: BORROW_LEND_USER_STATE_GAS
        }(
            abi.encode(user, token)
        );
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (BorrowLendUserTokenState)), true);
    }

    // ============ Borrow/Lend Reserve State ============

    /// @notice Query the global borrow/lend reserve state for a token.
    /// @param token Token index.
    /// @return Reserve state including rates, utilization, LTV, and pool totals.
    function borrowLendReserveState(uint64 token) internal view returns (BorrowLendReserveState memory) {
        (BorrowLendReserveState memory result, bool success) = tryBorrowLendReserveState(token);
        require(success, BorrowLendReserveStatePrecompileCallFailed());
        return result;
    }

    /// @notice Non-reverting version of `borrowLendReserveState`. Returns success=false if the
    /// precompile call fails.
    function tryBorrowLendReserveState(uint64 token)
        internal
        view
        returns (BorrowLendReserveState memory result, bool success)
    {
        (bool _success, bytes memory _result) = BORROW_LEND_RESERVE_STATE_PRECOMPILE_ADDRESS.staticcall{
            gas: BORROW_LEND_RESERVE_STATE_GAS
        }(
            abi.encode(token)
        );
        if (!_success) {
            return (result, false);
        }
        return (abi.decode(_result, (BorrowLendReserveState)), true);
    }
}
