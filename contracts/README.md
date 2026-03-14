# Sherwood Contracts

Solidity smart contracts for agent-managed investment syndicates on Base. Built with Foundry and OpenZeppelin (UUPS upgradeable).

## Contracts

| Contract | Description |
|----------|-------------|
| **SyndicateVault** | ERC-4626 vault with two-layer permission model. Holds all positions via delegatecall. Depositor whitelist, agent management, syndicate-level + per-agent caps, daily spend tracking, ragequit. |
| **SyndicateFactory** | Deploys vault proxies in one tx. Registers syndicates, stores metadata URIs, tracks active/inactive state. |
| **BatchExecutorLib** | Shared stateless library. Vault delegatecalls into it to execute batches of protocol calls (supply, borrow, swap, etc). Target allowlist enforced. |
| **StrategyRegistry** | On-chain registry of strategies. Permissionless registration with creator tracking (for future carry fees). |

### Interfaces

- `ISyndicateVault.sol` — Full vault interface including events
- `IStrategyRegistry.sol` — Strategy registration and lookup

### Architecture

```
                   ┌──────────────┐
                   │   Factory    │ ── creates vault proxies
                   └──────┬───────┘
                          │
              ┌───────────▼───────────┐
              │    SyndicateVault     │ ── ERC-4626, holds all positions
              │  (ERC1967 Proxy)      │
              │                       │
              │  delegatecall ───────►│── BatchExecutorLib (stateless)
              │                       │     target.call(data)
              └───────────────────────┘
```

- **Vault is the identity** — all DeFi positions (Moonwell supply/borrow, Uniswap LP, etc.) live on the vault address.
- **Delegatecall pattern** — vault calls the shared `BatchExecutorLib` via delegatecall. The lib is stateless; execution context is the vault.
- **Two-layer permissions** — on-chain caps (vault enforces maxPerTx, maxDailyTotal, maxBorrowRatio) + off-chain policies (Lit Actions).
- **UUPS upgradeable** — vault implementation can be upgraded. Never reorder storage slots.

## Quick Start

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)

### Build

```bash
cd contracts
forge build
```

### Test

```bash
forge test           # Run all tests (49 tests)
forge test -vvv      # Verbose output with traces
forge test --match-test test_deposit   # Run specific tests
```

### Format

```bash
forge fmt            # Format all Solidity files
forge fmt --check    # Check formatting without modifying
```

### Deploy

Deploy to Base mainnet (or any EVM chain):

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url $BASE_RPC_URL \
  --private-key $PRIVATE_KEY \
  --broadcast \
  --verify
```

The deploy script:
1. Deploys `BatchExecutorLib` (shared, stateless)
2. Deploys `SyndicateVault` implementation
3. Deploys `SyndicateFactory` (registers both)
4. Creates the first syndicate via the factory
5. Registers the deployer as an agent (dev mode)

Output includes all addresses to copy into `cli/.env`:
```
VAULT_ADDRESS=0x...
FACTORY_ADDRESS=0x...
EXECUTOR_LIB_ADDRESS=0x...
```

### Gas Snapshots

```bash
forge snapshot
```

## Key Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals) |
| WETH | `0x4200000000000000000000000000000000000006` |
| Moonwell Comptroller | `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C` |
| Moonwell mUSDC | `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22` |
| Uniswap V3 SwapRouter | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

## Tests

49 tests across 2 test suites:

### SyndicateVault (39 tests)

- ERC-4626 deposits and withdrawals
- Agent registration, removal, and cap enforcement
- Batch execution via delegatecall with target allowlist
- Syndicate-level and per-agent daily spend tracking
- Ragequit (pro-rata exit)
- Depositor whitelist (approve, remove, batch approve, open deposits toggle)
- Pause/unpause
- Simulation (dry-run via eth_call)

### SyndicateFactory (10 tests)

- Syndicate creation with full config
- Metadata updates
- Syndicate deactivation
- Vault functionality through factory-created proxies
- Depositor gating on factory-created vaults

## Subgraph

The Graph subgraph for indexed queries lives at `contracts/subgraph/`. See [docs/subgraph.md](../docs/subgraph.md) for available queries and schema reference.

### Build

```bash
cd contracts/subgraph
npm install
npx graph codegen && npx graph build
```

### Deploy

1. Create a subgraph at [The Graph Studio](https://thegraph.com/studio/) (network: Base)
2. Auth: `npx graph auth --studio <DEPLOY_KEY>`
3. Update `subgraph.yaml` with your factory address and deployment block
4. Deploy: `npx graph deploy --studio sherwood-syndicates`
5. Set `SUBGRAPH_URL` in `cli/.env` to the query endpoint from Studio

### Updating ABIs

If contracts change, re-extract ABIs from Foundry output:

```bash
forge build
node -e "const f=require('./out/SyndicateFactory.sol/SyndicateFactory.json'); require('fs').writeFileSync('subgraph/abis/SyndicateFactory.json', JSON.stringify(f.abi, null, 2))"
node -e "const f=require('./out/SyndicateVault.sol/SyndicateVault.json'); require('fs').writeFileSync('subgraph/abis/SyndicateVault.json', JSON.stringify(f.abi, null, 2))"
```

Then re-run `npx graph codegen && npx graph build`.

## Storage Layout (UUPS Safety)

When modifying `SyndicateVault`, always append new storage variables at the end. Never reorder or remove existing slots.

Current layout:
```
Slot  Variable
───── ─────────────────────────
inherited  ERC4626Upgradeable storage
inherited  OwnableUpgradeable storage
inherited  PausableUpgradeable storage
inherited  UUPSUpgradeable storage
1     _executorImpl (address)
2     _syndicateCaps (SyndicateCaps struct)
3     _agents (mapping)
4     _agentAddresses (address[])
5     _dailySpendTotal (uint256)
6     _lastResetDay (uint256)
7     _allowedTargets (EnumerableSet)
8     _approvedDepositors (EnumerableSet)
9     _openDeposits (bool)
```
