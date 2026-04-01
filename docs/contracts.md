# Contracts

Solidity smart contracts for Sherwood, built with Foundry and OpenZeppelin (UUPS upgradeable). All contracts deploy on Base.

## Architecture

```
                   ┌──────────────┐
                   │   Factory    │ ── deploys vault proxies, registers ENS subnames
                   └──────┬───────┘
                          │
              ┌───────────▼───────────┐
              │    SyndicateVault     │ ── ERC-4626, holds all DeFi positions
              │  (ERC1967 Proxy)      │
              │                       │
              │  delegatecall ───────►│── BatchExecutorLib (stateless)
              │                       │     target.call(data)
              └───────────────────────┘
```

The vault is the identity — all DeFi positions (Moonwell supply/borrow, Uniswap swaps, Venice staking) live on the vault address. Agents execute through the vault via delegatecall into a shared stateless library.

## Contracts

### SyndicateVault

ERC-4626 vault with two-layer permission model. Extends `ERC4626Upgradeable`, `OwnableUpgradeable`, `PausableUpgradeable`, `UUPSUpgradeable`, `ERC721Holder`.

**Permissions:**
- **Layer 1 (onchain):** Syndicate caps (`maxPerTx`, `maxDailyTotal`, `maxBorrowRatio`) + per-agent caps + target allowlist
- **Layer 2 (offchain):** Lit Action policies on agent PKP wallets

**Key functions:**
- `executeBatch(calls, assetAmount)` — delegatecalls to BatchExecutorLib. Enforces caps and target allowlist.
- `simulateBatch(calls)` — dry-run via `eth_call`, returns success/failure per call without submitting onchain
- `ragequit(receiver)` — LP emergency exit, burns all shares for pro-rata assets
- `registerAgent(agentId, pkp, eoa, limits)` — registers agent with ERC-8004 identity verification
- `deposit(assets, receiver)` / `withdraw(assets, receiver, owner)` — standard ERC-4626 with `totalDeposited` tracking

**Storage:**
- `_syndicateCaps` — syndicate-wide spending limits
- `_agents` mapping — pkp address → `AgentConfig` (agentId, operatorEOA, limits, active)
- `_allowedTargets` — `EnumerableSet` of whitelisted protocol addresses
- `_approvedDepositors` — `EnumerableSet` of whitelisted depositor addresses
- `_openDeposits` — bool toggle for permissionless deposits
- `_dailySpendTotal` / `_lastResetDay` — rolling daily spend tracking
- `totalDeposited` — cumulative deposits minus withdrawals (for profit calculation)

### SyndicateFactory

Deploys vault proxies (ERC1967) in one transaction. Registers ENS subnames atomically. Verifies ERC-8004 agent identity ownership on creation.

**Storage:**
- `syndicates[]` — syndicate ID → struct (vault, creator, metadata, subdomain, active)
- `vaultToSyndicate` — reverse lookup from vault address
- `subdomainToSyndicate` — reverse lookup from ENS subdomain

### BatchExecutorLib

Shared stateless library. Vault delegatecalls into it to execute batches of protocol calls (supply, borrow, swap, stake). Each call's target must be in the vault's allowlist.

### StrategyRegistry

Onchain registry of strategy implementations. Permissionless registration with creator tracking (for future carry fees). UUPS upgradeable.

## Deployed Addresses

### Sherwood (Base Sepolia)

| Contract | Address |
|----------|---------|
| SyndicateFactory | `0xc705F04fF2781aF9bB53ba416Cb32A29540c4624` |
| StrategyRegistry | `0x8A45f769553D10F26a6633d019B04f7805b1368A` |
| SyndicateVault (impl) | `0x7E1F71A72a88Ce8418cf82CACDE9ce5Bbbcf5772` |
| BatchExecutorLib | `0x0c63Ea92336eA0324B81eB6D0fD62455eC38091b` |

### External (Base Mainnet)

| Contract | Address |
|----------|---------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals) |
| WETH | `0x4200000000000000000000000000000000000006` |
| Moonwell Comptroller | `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C` |
| Moonwell mUSDC | `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22` |
| Uniswap V3 SwapRouter | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

### ERC-8004 Identity (not ours)

| Contract | Base Mainnet | Base Sepolia |
|----------|-------------|--------------|
| IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `0x8004B663056A597Dffe9eCcC1965A193B7388713` |

## Testing

66 tests across 2 test suites.

```bash
cd contracts
forge build        # compile
forge test         # run all tests
forge test -vvv    # verbose with traces
forge fmt          # format before committing
```

**SyndicateVault (49 tests):** ERC-4626 deposits/withdrawals, agent registration with ERC-8004 verification, batch execution with target allowlist, syndicate + per-agent daily spend tracking, ragequit, depositor whitelist, total deposited tracking, pause/unpause, simulation, fuzz testing.

**SyndicateFactory (17 tests):** Syndicate creation with ENS subname registration, ERC-8004 verification on create, metadata updates, deactivation, proxy storage isolation, subdomain availability.

## Deployment

```bash
forge script script/testnet/Deploy.s.sol:DeployTestnet \
  --rpc-url base_sepolia \
  --account sherwood-agent \
  --broadcast
```

Deployment records saved in `contracts/chains/{chainId}.json`.

## Storage Layout (UUPS Safety)

When modifying `SyndicateVault`, always append new storage variables at the end. Never reorder or remove existing slots. See `contracts/README.md` for the full slot map.
