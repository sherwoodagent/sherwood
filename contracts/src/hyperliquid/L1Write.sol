// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Interface for the HyperCore system contract at 0x3333...3333.
///         On real HyperEVM, the precompile at 0x3333...3333 processes
///         RawAction events natively. For testing, use
///         test/mocks/MockCoreWriter.sol with vm.etch.
interface ICoreWriter {
    event RawAction(address indexed user, bytes data);

    function sendRawAction(bytes calldata data) external;
}

// ============ Enums ============

/// @notice Order time-in-force policy
enum TimeInForce {
    Alo, // Encoded as 1
    Gtc, // Encoded as 2
    Ioc // Encoded as 3
}

/// @notice Variant for finalizing an EVM contract
enum FinalizeVariant {
    Create, // Encoded as 1
    FirstStorageSlot, // Encoded as 2
    CustomStorageSlot // Encoded as 3
}

/// @notice Borrow/lend operation type (Testnet-only)
enum BorrowLendOperation {
    Supply, // 0
    Withdraw // 1
}

// ============ Constants ============

// Sentinel value for the spot DEX index
uint32 constant SPOT_DEX = type(uint32).max;
// Sentinel value to maximally apply a borrow/lend operation
uint64 constant BORROW_LEND_MAX_AMOUNT = 0;
// Sentinel value indicating no client order ID
uint128 constant NO_CLOID = 0;

// ============ Library ============

library L1Write {
    address constant CORE_WRITER_ADDRESS = 0x3333333333333333333333333333333333333333;

    // Action selectors (version byte 0x01 + 3-byte action ID)
    bytes4 constant ACTION_LIMIT_ORDER = 0x01000001;
    bytes4 constant ACTION_VAULT_TRANSFER = 0x01000002;
    bytes4 constant ACTION_TOKEN_DELEGATE = 0x01000003;
    bytes4 constant ACTION_STAKING_DEPOSIT = 0x01000004;
    bytes4 constant ACTION_STAKING_WITHDRAW = 0x01000005;
    bytes4 constant ACTION_SPOT_SEND = 0x01000006;
    bytes4 constant ACTION_USD_CLASS_TRANSFER = 0x01000007;
    bytes4 constant ACTION_FINALIZE_EVM_CONTRACT = 0x01000008;
    bytes4 constant ACTION_ADD_API_WALLET = 0x01000009;
    bytes4 constant ACTION_CANCEL_ORDER_BY_OID = 0x0100000a;
    bytes4 constant ACTION_CANCEL_ORDER_BY_CLOID = 0x0100000b;
    bytes4 constant ACTION_APPROVE_BUILDER_FEE = 0x0100000c;
    bytes4 constant ACTION_SEND_ASSET = 0x0100000d;
    bytes4 constant ACTION_REFLECT_EVM_SUPPLY_CHANGE = 0x0100000e;
    bytes4 constant ACTION_BORROW_LEND_OPERATION = 0x0100000f;
    bytes4 constant ACTION_UPDATE_LEVERAGE = 0x01000010;

    /// @notice Encodes an update leverage action
    /// @param asset The perp asset index
    /// @param isCross Whether to use cross margin (true) or isolated margin (false)
    /// @param leverage The leverage multiplier
    function encodeUpdateLeverage(uint32 asset, bool isCross, uint32 leverage) internal pure returns (bytes memory) {
        return abi.encodePacked(ACTION_UPDATE_LEVERAGE, abi.encode(asset, isCross, leverage));
    }

    /// @notice Sends an update leverage action
    /// @param asset The perp asset index
    /// @param isCross Whether to use cross margin (true) or isolated margin (false)
    /// @param leverage The leverage multiplier
    function sendUpdateLeverage(uint32 asset, bool isCross, uint32 leverage) internal {
        _sendAction(encodeUpdateLeverage(asset, isCross, leverage));
    }

    /// @notice Encodes a limit order action
    /// @param asset The perp asset index
    /// @param isBuy Whether this is a buy order
    /// @param limitPx Raw limit price in HyperCore units (protocol-defined precision)
    /// @param sz Raw size in HyperCore units (protocol-defined precision)
    /// @param reduceOnly Whether this is a reduce-only order
    /// @param tif Time in force
    /// @param cloid Client order ID (NO_CLOID means no cloid)
    function encodeLimitOrder(
        uint32 asset,
        bool isBuy,
        uint64 limitPx,
        uint64 sz,
        bool reduceOnly,
        TimeInForce tif,
        uint128 cloid
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            ACTION_LIMIT_ORDER, abi.encode(asset, isBuy, limitPx, sz, reduceOnly, uint8(tif) + 1, cloid)
        );
    }

    /// @notice Sends a limit order action
    /// @param asset The perp asset index
    /// @param isBuy Whether this is a buy order
    /// @param limitPx Raw limit price in HyperCore units (protocol-defined precision)
    /// @param sz Raw size in HyperCore units (protocol-defined precision)
    /// @param reduceOnly Whether this is a reduce-only order
    /// @param tif Time in force
    /// @param cloid Client order ID (NO_CLOID means no cloid)
    function sendLimitOrder(
        uint32 asset,
        bool isBuy,
        uint64 limitPx,
        uint64 sz,
        bool reduceOnly,
        TimeInForce tif,
        uint128 cloid
    ) internal {
        _sendAction(encodeLimitOrder(asset, isBuy, limitPx, sz, reduceOnly, tif, cloid));
    }

    /// @notice Encodes a vault transfer action
    /// @param vault The vault address
    /// @param isDeposit Whether this is a deposit (true) or withdrawal (false)
    /// @param usd Raw USD amount in HyperCore units (protocol-defined precision)
    function encodeVaultTransfer(address vault, bool isDeposit, uint64 usd) internal pure returns (bytes memory) {
        return abi.encodePacked(ACTION_VAULT_TRANSFER, abi.encode(vault, isDeposit, usd));
    }

    /// @notice Sends a vault transfer action
    /// @param vault The vault address
    /// @param isDeposit Whether this is a deposit (true) or withdrawal (false)
    /// @param usd Raw USD amount in HyperCore units (protocol-defined precision)
    function sendVaultTransfer(address vault, bool isDeposit, uint64 usd) internal {
        _sendAction(encodeVaultTransfer(vault, isDeposit, usd));
    }

    /// @notice Encodes a token delegate action
    /// @param validator The validator address
    /// @param amount Amount to delegate/undelegate
    /// @param isUndelegate Whether this is an undelegate operation
    function encodeTokenDelegate(address validator, uint64 amount, bool isUndelegate)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(ACTION_TOKEN_DELEGATE, abi.encode(validator, amount, isUndelegate));
    }

    /// @notice Sends a token delegate action
    /// @param validator The validator address
    /// @param amount Amount to delegate/undelegate
    /// @param isUndelegate Whether this is an undelegate operation
    function sendTokenDelegate(address validator, uint64 amount, bool isUndelegate) internal {
        _sendAction(encodeTokenDelegate(validator, amount, isUndelegate));
    }

    /// @notice Encodes a staking deposit action
    /// @param amount Amount to deposit
    function encodeStakingDeposit(uint64 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(ACTION_STAKING_DEPOSIT, abi.encode(amount));
    }

    /// @notice Sends a staking deposit action
    /// @param amount Amount to deposit
    function sendStakingDeposit(uint64 amount) internal {
        _sendAction(encodeStakingDeposit(amount));
    }

    /// @notice Encodes a staking withdraw action
    /// @param amount Amount to withdraw
    function encodeStakingWithdraw(uint64 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(ACTION_STAKING_WITHDRAW, abi.encode(amount));
    }

    /// @notice Sends a staking withdraw action
    /// @param amount Amount to withdraw
    function sendStakingWithdraw(uint64 amount) internal {
        _sendAction(encodeStakingWithdraw(amount));
    }

    /// @notice Encodes a spot send action
    /// @param destination Destination address
    /// @param token Token index
    /// @param amount Amount to send
    function encodeSpotSend(address destination, uint64 token, uint64 amount) internal pure returns (bytes memory) {
        return abi.encodePacked(ACTION_SPOT_SEND, abi.encode(destination, token, amount));
    }

    /// @notice Sends a spot send action
    /// @param destination Destination address
    /// @param token Token index
    /// @param amount Amount to send
    function sendSpotSend(address destination, uint64 token, uint64 amount) internal {
        _sendAction(encodeSpotSend(destination, token, amount));
    }

    /// @notice Encodes a USD class transfer action
    /// @param ntl Raw transfer amount in HyperCore units (protocol-defined precision)
    /// @param toPerp Whether to transfer to perp (true) or from perp (false)
    function encodeUsdClassTransfer(uint64 ntl, bool toPerp) internal pure returns (bytes memory) {
        return abi.encodePacked(ACTION_USD_CLASS_TRANSFER, abi.encode(ntl, toPerp));
    }

    /// @notice Sends a USD class transfer action
    /// @param ntl Raw transfer amount in HyperCore units (protocol-defined precision)
    /// @param toPerp Whether to transfer to perp (true) or from perp (false)
    function sendUsdClassTransfer(uint64 ntl, bool toPerp) internal {
        _sendAction(encodeUsdClassTransfer(ntl, toPerp));
    }

    /// @notice Encodes a finalize EVM contract action
    /// @param token Token index
    /// @param variant Finalize variant
    /// @param createNonce Create nonce (used if variant is Create)
    function encodeFinalizeEvmContract(uint64 token, FinalizeVariant variant, uint64 createNonce)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(ACTION_FINALIZE_EVM_CONTRACT, abi.encode(token, uint8(variant) + 1, createNonce));
    }

    /// @notice Sends a finalize EVM contract action
    /// @param token Token index
    /// @param variant Finalize variant
    /// @param createNonce Create nonce (used if variant is Create)
    function sendFinalizeEvmContract(uint64 token, FinalizeVariant variant, uint64 createNonce) internal {
        _sendAction(encodeFinalizeEvmContract(token, variant, createNonce));
    }

    /// @notice Encodes an add API wallet action
    /// @param apiWallet The API wallet address
    /// @param apiWalletName The API wallet name (empty string makes this the main API wallet/agent)
    function encodeAddApiWallet(address apiWallet, string memory apiWalletName) internal pure returns (bytes memory) {
        return abi.encodePacked(ACTION_ADD_API_WALLET, abi.encode(apiWallet, apiWalletName));
    }

    /// @notice Sends an add API wallet action
    /// @param apiWallet The API wallet address
    /// @param apiWalletName The API wallet name (empty string makes this the main API wallet/agent)
    function sendAddApiWallet(address apiWallet, string memory apiWalletName) internal {
        _sendAction(encodeAddApiWallet(apiWallet, apiWalletName));
    }

    /// @notice Encodes a cancel order by oid action
    /// @param asset The perp asset index
    /// @param oid The order ID to cancel
    function encodeCancelOrderByOid(uint32 asset, uint64 oid) internal pure returns (bytes memory) {
        return abi.encodePacked(ACTION_CANCEL_ORDER_BY_OID, abi.encode(asset, oid));
    }

    /// @notice Sends a cancel order by oid action
    /// @param asset The perp asset index
    /// @param oid The order ID to cancel
    function sendCancelOrderByOid(uint32 asset, uint64 oid) internal {
        _sendAction(encodeCancelOrderByOid(asset, oid));
    }

    /// @notice Encodes a cancel order by cloid action
    /// @param asset The perp asset index
    /// @param cloid The client order ID to cancel
    function encodeCancelOrderByCloid(uint32 asset, uint128 cloid) internal pure returns (bytes memory) {
        return abi.encodePacked(ACTION_CANCEL_ORDER_BY_CLOID, abi.encode(asset, cloid));
    }

    /// @notice Sends a cancel order by cloid action
    /// @param asset The perp asset index
    /// @param cloid The client order ID to cancel
    function sendCancelOrderByCloid(uint32 asset, uint128 cloid) internal {
        _sendAction(encodeCancelOrderByCloid(asset, cloid));
    }

    /// @notice Encodes an approve builder fee action
    /// @param maxFeeRate Maximum fee rate in decibps (e.g., 10 for 0.01%)
    /// @param builder The builder address
    function encodeApproveBuilderFee(uint64 maxFeeRate, address builder) internal pure returns (bytes memory) {
        return abi.encodePacked(ACTION_APPROVE_BUILDER_FEE, abi.encode(maxFeeRate, builder));
    }

    /// @notice Sends an approve builder fee action
    /// @param maxFeeRate Maximum fee rate in decibps (e.g., 10 for 0.01%)
    /// @param builder The builder address
    function sendApproveBuilderFee(uint64 maxFeeRate, address builder) internal {
        _sendAction(encodeApproveBuilderFee(maxFeeRate, builder));
    }

    /// @notice Encodes a send asset action
    /// @param destination Destination address
    /// @param subAccount Sub-account address (zero address if not using sub-account)
    /// @param sourceDex Source DEX index (SPOT_DEX for spot)
    /// @param destinationDex Destination DEX index (SPOT_DEX for spot)
    /// @param token Token index
    /// @param amount Amount to send
    function encodeAsset(
        address destination,
        address subAccount,
        uint32 sourceDex,
        uint32 destinationDex,
        uint64 token,
        uint64 amount
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(
            ACTION_SEND_ASSET, abi.encode(destination, subAccount, sourceDex, destinationDex, token, amount)
        );
    }

    /// @notice Sends a send asset action
    /// @param destination Destination address
    /// @param subAccount Sub-account address (zero address if not using sub-account)
    /// @param sourceDex Source DEX index (SPOT_DEX for spot)
    /// @param destinationDex Destination DEX index (SPOT_DEX for spot)
    /// @param token Token index
    /// @param amount Amount to send
    function sendAsset(
        address destination,
        address subAccount,
        uint32 sourceDex,
        uint32 destinationDex,
        uint64 token,
        uint64 amount
    ) internal {
        _sendAction(encodeAsset(destination, subAccount, sourceDex, destinationDex, token, amount));
    }

    /// @notice Encodes a reflect EVM supply change for aligned quote token action
    /// @param token Token index
    /// @param amount Amount to mint/burn
    /// @param isMint Whether this is a mint (true) or burn (false)
    function encodeReflectEvmSupplyChange(uint64 token, uint64 amount, bool isMint)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(ACTION_REFLECT_EVM_SUPPLY_CHANGE, abi.encode(token, amount, isMint));
    }

    /// @notice Sends a reflect EVM supply change for aligned quote token action
    /// @param token Token index
    /// @param amount Amount to mint/burn
    /// @param isMint Whether this is a mint (true) or burn (false)
    function sendReflectEvmSupplyChange(uint64 token, uint64 amount, bool isMint) internal {
        _sendAction(encodeReflectEvmSupplyChange(token, amount, isMint));
    }

    /// @notice Encodes a borrow lend operation action (Testnet-only)
    /// @param operation Operation type
    /// @param token Token index
    /// @param amount Amount (BORROW_LEND_MAX_AMOUNT means maximally apply the operation)
    function encodeBorrowLendOperation(BorrowLendOperation operation, uint64 token, uint64 amount)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(ACTION_BORROW_LEND_OPERATION, abi.encode(uint8(operation), token, amount));
    }

    /// @notice Sends a borrow lend operation action (Testnet-only)
    /// @param operation Operation type
    /// @param token Token index
    /// @param amount Amount (BORROW_LEND_MAX_AMOUNT means maximally apply the operation)
    function sendBorrowLendOperation(BorrowLendOperation operation, uint64 token, uint64 amount) internal {
        _sendAction(encodeBorrowLendOperation(operation, token, amount));
    }

    /// @notice Internal helper to send an action to CoreWriter
    /// @param data The fully encoded action data
    function _sendAction(bytes memory data) private {
        ICoreWriter(CORE_WRITER_ADDRESS).sendRawAction(data);
    }
}
