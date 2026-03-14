# Plan A: Delegatecall Refactor

## Summary

Merge BatchExecutor logic into SyndicateVault via delegatecall. One shared executor implementation deployed once. Each syndicate = one vault proxy. Vault holds all positions, capital, and state.

## Current Architecture (2 contracts per syndicate)

```
SyndicateVault (proxy)     BatchExecutor (standalone)
├── ERC-4626 (deposits)    ├── executeBatch(Call[])
├── Agent registry         ├── simulateBatch(Call[])
├── Caps + daily limits    ├── Target allowlist
└── executeStrategy()──────└── Holds mTokens, borrows, swaps
```

Problem: executor holds DeFi positions. Can't share across syndicates.

## New Architecture (1 contract per syndicate)

```
BatchExecutorLib (deployed once, shared)
├── executeBatch(Call[])     ← pure logic, no state
└── simulateBatch(Call[])    ← pure logic, no state

SyndicateVault (proxy per syndicate)
├── ERC-4626 (deposits, shares)
├── Agent registry (PKPs, caps, daily limits)
├── Target allowlist (EnumerableSet)
├── executeBatch() → delegatecall to BatchExecutorLib
├── simulateBatch() → delegatecall to BatchExecutorLib
└── Holds everything: capital, mTokens, borrows, swapped tokens
```

Factory deploys vault proxies. One tx = one syndicate.

## Why Delegatecall

When vault delegatecalls the executor:
- Code runs from BatchExecutorLib
- But `msg.sender` for sub-calls = vault address
- Storage reads/writes happen on vault's storage
- `address(this)` = vault address

So when the executor does `mUSDC.mint(10000)`, the mTokens are minted TO the vault. When it does `mUSDC.borrow(5000)`, the debt is ON the vault. Positions are naturally isolated per syndicate. No commingling.

## Contract Changes

### BatchExecutorLib.sol (new — replaces BatchExecutor.sol)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title BatchExecutorLib
 * @notice Stateless batch execution logic. Called via delegatecall from vaults.
 *         All state (allowlist, positions) lives in the calling vault's storage.
 */
contract BatchExecutorLib {
    struct Call {
        address target;
        bytes data;
        uint256 value;
    }

    struct CallResult {
        bool success;
        bytes returnData;
    }

    // These storage slots are read from the VAULT's storage via delegatecall.
    // Must match the layout in SyndicateVault exactly.

    // Slot for the target allowlist — use a fixed storage slot to avoid collisions
    // with ERC-4626 / OZ storage.
    bytes32 private constant ALLOWED_TARGETS_SLOT = keccak256("sherwood.executor.allowedTargets");

    /**
     * @notice Execute a batch of calls atomically.
     * @dev Called via delegatecall from vault. All calls execute as the vault.
     *      Reads allowlist from vault's storage.
     */
    function executeBatch(Call[] calldata calls) external {
        for (uint256 i = 0; i < calls.length; i++) {
            require(_isAllowed(calls[i].target), "Target not allowed");

            (bool success, bytes memory returnData) = calls[i].target.call{value: calls[i].value}(
                calls[i].data
            );
            if (!success) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
        }
    }

    /**
     * @notice Simulate a batch without reverting.
     * @dev Call via eth_call for dry-run. Returns per-call results.
     */
    function simulateBatch(Call[] calldata calls) external returns (CallResult[] memory results) {
        results = new CallResult[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            if (!_isAllowed(calls[i].target)) {
                results[i] = CallResult(false, bytes("Target not allowed"));
                continue;
            }
            (bool success, bytes memory returnData) = calls[i].target.call{value: calls[i].value}(
                calls[i].data
            );
            results[i] = CallResult(success, returnData);
        }
    }

    function _isAllowed(address target) internal view returns (bool) {
        // Read from vault's storage via namespaced slot
        // Implementation depends on how we store the allowlist
        // Option 1: Simple mapping at a known slot
        // Option 2: EnumerableSet at a known slot
        // See "Storage Layout" section below
    }
}
```

### SyndicateVault.sol changes

```solidity
// Add to existing SyndicateVault:

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

contract SyndicateVault is ... {
    using EnumerableSet for EnumerableSet.AddressSet;

    /// @notice Shared executor implementation (deployed once)
    address public immutable executorImpl;

    /// @notice Approved protocol targets for batch execution
    /// @dev Uses ERC-7201 namespaced storage to avoid collisions
    /// keccak256(abi.encode(uint256(keccak256("sherwood.executor.allowedTargets")) - 1)) & ~bytes32(uint256(0xff))
    EnumerableSet.AddressSet private _allowedTargets;

    // ── Batch Execution ──

    /// @notice Execute a batch of protocol calls atomically
    /// @dev Delegatecalls into shared executor. All calls execute as this vault.
    ///      Agent must be registered and within caps.
    function executeBatch(
        BatchExecutorLib.Call[] calldata calls,
        uint256 assetAmount
    ) external {
        AgentConfig storage agent = agents[msg.sender];
        require(agent.active, "Not registered agent");
        require(assetAmount <= agent.maxPerTx, "Exceeds per-tx cap");

        agent.dailySpent += assetAmount;
        require(agent.dailySpent <= agent.dailyLimit, "Exceeds daily limit");

        syndicateDailySpent += assetAmount;
        require(syndicateDailySpent <= syndicateCaps.maxDailyTotal, "Exceeds syndicate limit");

        // Delegatecall — executor logic runs with vault's storage and address
        (bool success, bytes memory returnData) = executorImpl.delegatecall(
            abi.encodeCall(BatchExecutorLib.executeBatch, (calls))
        );
        if (!success) {
            assembly {
                revert(add(returnData, 32), mload(returnData))
            }
        }
    }

    /// @notice Simulate a batch (call via eth_call)
    function simulateBatch(
        BatchExecutorLib.Call[] calldata calls
    ) external returns (BatchExecutorLib.CallResult[] memory) {
        (bool success, bytes memory returnData) = executorImpl.delegatecall(
            abi.encodeCall(BatchExecutorLib.simulateBatch, (calls))
        );
        require(success, "Simulation failed");
        return abi.decode(returnData, (BatchExecutorLib.CallResult[]));
    }

    // ── Target Allowlist ──

    function addTarget(address target) external onlyOwner {
        require(_allowedTargets.add(target), "Already allowed");
    }

    function removeTarget(address target) external onlyOwner {
        require(_allowedTargets.remove(target), "Not allowed");
    }

    function addTargets(address[] calldata targets) external onlyOwner {
        for (uint256 i = 0; i < targets.length; i++) {
            _allowedTargets.add(targets[i]);
        }
    }

    function isAllowedTarget(address target) external view returns (bool) {
        return _allowedTargets.contains(target);
    }

    function getAllowedTargets() external view returns (address[] memory) {
        return _allowedTargets.values();
    }
}
```

## Storage Layout (Critical)

Delegatecall means the executor reads/writes the VAULT's storage. Must avoid slot collisions between vault state and executor state.

**Approach: ERC-7201 namespaced storage**

The vault already uses OZ upgradeable contracts which use namespaced storage. We store the allowlist in its own namespace:

```solidity
/// @custom:storage-location erc7201:sherwood.storage.executor
struct ExecutorStorage {
    EnumerableSet.AddressSet allowedTargets;
}

// keccak256(abi.encode(uint256(keccak256("sherwood.storage.executor")) - 1)) & ~bytes32(uint256(0xff))
bytes32 private constant EXECUTOR_STORAGE_SLOT = 0x...;

function _getExecutorStorage() private pure returns (ExecutorStorage storage s) {
    bytes32 slot = EXECUTOR_STORAGE_SLOT;
    assembly {
        s.slot := slot
    }
}
```

The executor lib reads from the SAME slot. Both contracts compute the slot the same way → they access the same storage when delegatecall runs.

**Alternative (simpler for hackathon):** Just put the allowlist directly in the vault as a regular state variable. Since the executor only READS the allowlist (via `_isAllowed`), and we control the vault's storage layout, we can use a simple approach:

```solidity
// In vault — the executor reads this via delegatecall
mapping(address => bool) public allowedTargets;
```

The executor's `_isAllowed` function reads from the same storage slot because delegatecall preserves the caller's storage context. As long as the mapping variable is at the same slot in both contracts' layouts, it works.

**For hackathon: use the simple mapping approach. Migrate to ERC-7201 namespaced storage post-hackathon if needed.**

## SyndicateFactory.sol (new)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract SyndicateFactory {
    struct SyndicateConfig {
        string metadataURI;       // ipfs://Qm... (name, description, strategies)
        address asset;            // USDC address
        string name;              // Vault token name
        string symbol;            // Vault token symbol
        uint256 maxPerTx;         // Syndicate-wide per-tx cap
        uint256 maxDailyTotal;    // Syndicate-wide daily cap
        uint256 maxBorrowRatio;   // Max borrow ratio (basis points)
        address[] initialTargets; // Protocol addresses to allow
    }

    struct Syndicate {
        uint256 id;
        address vault;            // ERC-4626 vault (proxy)
        address creator;
        string metadataURI;       // ipfs://... via Pinata
        uint256 createdAt;
        bool active;
    }

    /// @notice Shared executor implementation
    address public immutable executorImpl;

    /// @notice Shared vault implementation (for UUPS proxies)
    address public immutable vaultImpl;

    /// @notice All syndicates
    mapping(uint256 => Syndicate) public syndicates;
    uint256 public syndicateCount;

    /// @notice Vault address → syndicate ID
    mapping(address => uint256) public vaultToSyndicate;

    event SyndicateCreated(
        uint256 indexed id,
        address indexed vault,
        address indexed creator,
        string metadataURI
    );

    constructor(address executorImpl_, address vaultImpl_) {
        executorImpl = executorImpl_;
        vaultImpl = vaultImpl_;
    }

    /// @notice Create a new syndicate — deploys vault proxy, registers everything
    /// @param config Syndicate configuration
    /// @return syndicateId The new syndicate's ID
    /// @return vault The deployed vault proxy address
    function createSyndicate(
        SyndicateConfig calldata config
    ) external returns (uint256 syndicateId, address vault) {
        syndicateId = ++syndicateCount;

        // Deploy vault as UUPS proxy
        bytes memory initData = abi.encodeCall(
            SyndicateVault.initialize,
            (
                config.asset,
                config.name,
                config.symbol,
                msg.sender,          // owner = creator
                executorImpl,        // shared executor
                config.maxPerTx,
                config.maxDailyTotal,
                config.maxBorrowRatio,
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
    }

    /// @notice Deactivate a syndicate (creator only)
    function deactivate(uint256 syndicateId) external {
        Syndicate storage s = syndicates[syndicateId];
        require(s.creator == msg.sender, "Not creator");
        s.active = false;
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
```

## IPFS Metadata Schema (Pinata)

Pin via Pinata API. The metadataURI in the syndicate points here.

```json
{
  "schema": "sherwood.syndicate.v1",
  "name": "Alpha Seekers",
  "description": "Leveraged long strategies on Base blue chips using Moonwell + Uniswap",
  "logo": "ipfs://Qm.../logo.png",
  "chain": "base",
  "strategies": [
    {
      "id": "levered-swap",
      "name": "Levered Swap",
      "description": "Deposit USDC collateral on Moonwell, borrow, swap into target token on Uniswap V3. Unwind when profit target or stop loss hit.",
      "protocols": ["Moonwell", "Uniswap V3"],
      "riskLevel": "medium",
      "actions": ["DEPOSIT_COLLATERAL", "BORROW", "SWAP", "REPAY", "WITHDRAW"]
    }
  ],
  "terms": {
    "minDeposit": "100000000",
    "minDepositFormatted": "100 USDC",
    "feeModel": "2% management + 20% carry",
    "ragequitEnabled": true,
    "lockPeriod": 0
  },
  "agents": [
    {
      "erc8004Id": 42,
      "name": "Agent Alpha",
      "description": "Autonomous DeFi agent specializing in leveraged positions on Base",
      "litPKP": "0x...",
      "specialties": ["lending", "swaps", "leverage"],
      "attestationSchema": "0x..."
    }
  ],
  "links": {
    "xmtpGroupId": "...",
    "dashboard": "https://sherwood.fi/syndicate/1",
    "github": "https://github.com/imthatcarlos/sherwood"
  }
}
```

## Migration Steps

1. **Refactor BatchExecutor.sol → BatchExecutorLib.sol**
   - Remove all state (allowlist, vault reference, owner)
   - Remove access control (onlyVault, onlyOwner)
   - Keep executeBatch() and simulateBatch() as pure logic
   - Add _isAllowed() that reads from delegatecall storage

2. **Update SyndicateVault.sol**
   - Add `executorImpl` immutable (set in initialize)
   - Add `_allowedTargets` EnumerableSet (or simple mapping)
   - Add `executeBatch()` that checks agent caps then delegatecalls
   - Add `simulateBatch()` that delegatecalls
   - Add target management functions (addTarget, removeTarget, etc.)
   - Update `initialize()` to accept executorImpl + initial targets

3. **Create SyndicateFactory.sol**
   - Constructor takes executorImpl + vaultImpl
   - `createSyndicate()` deploys proxy, initializes, registers
   - Syndicate struct with metadata URI
   - Events indexed for dashboard queries

4. **Update tests**
   - Remove standalone BatchExecutor tests
   - Add delegatecall execution tests to vault test suite
   - Add factory tests (create syndicate, verify wiring)
   - Test storage isolation (two syndicates, independent positions)

5. **Delete BatchExecutor.sol** (replaced by lib)

## Gas Comparison

| Action | Before (2 contracts) | After (delegatecall) |
|--------|---------------------|---------------------|
| Create syndicate | ~2M (vault proxy + executor) | ~1M (vault proxy only) |
| Execute batch | ~50K overhead (call to executor) | ~40K overhead (delegatecall) |
| Simulate | Same | Same |

Delegatecall is slightly cheaper than a regular external call. Main savings is deployment — one fewer contract per syndicate.

## Risk: Storage Collisions

The biggest risk with delegatecall is storage slot collisions between the vault and executor code. Mitigations:

1. **Executor is stateless** — it reads the allowlist from a known slot but writes nothing to storage (positions are created by external calls TO other protocols)
2. **ERC-7201 namespaced storage** — if we need executor-specific storage, use a deterministic slot far from OZ's storage
3. **For hackathon: simple mapping in vault, executor reads it via delegatecall. Test thoroughly.**

## Files to Create/Modify

```
contracts/src/
├── SyndicateVault.sol        ← MODIFY (add executeBatch, allowlist, executorImpl)
├── BatchExecutorLib.sol      ← NEW (stateless logic)
├── SyndicateFactory.sol      ← NEW (factory + registry)
├── BatchExecutor.sol         ← DELETE
└── interfaces/
    ├── ISyndicateVault.sol   ← MODIFY (add new functions)
    └── ISyndicateFactory.sol ← NEW

contracts/test/
├── SyndicateVault.t.sol      ← MODIFY (add execution tests)
├── SyndicateFactory.t.sol    ← NEW
├── BatchExecutor.t.sol       ← DELETE
└── mocks/                    ← Keep existing mocks
```
