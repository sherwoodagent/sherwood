# Sherwood

Agent-managed investment syndicates on Base. Autonomous DeFi strategies with verifiable track records.

## Structure

```
contracts/           Solidity smart contracts (Foundry)
contracts/subgraph/  The Graph subgraph for indexed queries
cli/                 TypeScript CLI for agents + LPs (viem)
docs/                Documentation
app/                 Dashboard (Next.js + Tailwind)
```

## How It Works

1. **Creators** deploy a syndicate via the factory — an ERC-4626 vault with agent permissions, spending caps, and a target allowlist
2. **LPs** deposit USDC into a syndicate vault and receive shares. Depositor whitelist or open deposits.
3. **Agents** (Lit PKP wallets) execute DeFi strategies through the vault — supply, borrow, swap — all positions live on the vault
4. **Anyone** can ragequit at any time for their pro-rata share of vault assets

## Contracts

- **SyndicateVault** — ERC-4626 vault with delegatecall execution. Two-layer permissions (syndicate caps + per-agent caps). Depositor whitelist. Ragequit.
- **SyndicateFactory** — Deploys vault proxies. Metadata via IPFS (Pinata).
- **BatchExecutorLib** — Shared stateless library for batched protocol calls (supply, borrow, swap). Target allowlist.
- **StrategyRegistry** — On-chain strategy catalog with creator tracking.

49 tests passing. See [contracts/README.md](contracts/README.md) for build, test, deploy instructions.

## CLI

TypeScript CLI for syndicate management, LP operations, and strategy execution.

```bash
cd cli && npm install

# Syndicate management
sherwood syndicate create --name "Alpha Fund" --symbol "shUSDC" --max-per-tx 10000 --max-daily 50000
sherwood syndicate list                          # Queries subgraph (or on-chain fallback)
sherwood syndicate info 1                        # Vault stats + metadata
sherwood syndicate approve-depositor --vault 0x... --depositor 0x...

# LP operations
sherwood vault deposit --vault 0x... --amount 1000
sherwood vault balance --vault 0x...
sherwood vault ragequit --vault 0x...

# Strategy execution
sherwood strategy run --vault 0x... --collateral 1.0 --borrow 500 --token 0x... --execute

# Vault admin
sherwood vault info --vault 0x...
sherwood vault add-target --vault 0x... --target 0x...
sherwood vault register-agent --vault 0x... --pkp 0x... --eoa 0x... --max-per-tx 5000 --daily-limit 25000
```

## Stack

- **Contracts**: Foundry, Solidity 0.8.28, OpenZeppelin UUPS upgradeable
- **CLI**: TypeScript, viem, Commander
- **Subgraph**: The Graph (AssemblyScript)
- **IPFS**: Pinata (syndicate metadata)
- **Chain**: Base mainnet
- **Protocols**: Moonwell (lending), Uniswap V3 (swaps)

## Docs

- [Subgraph schema, queries, and deployment](docs/subgraph.md)
- [Contracts spec and deployment](contracts/README.md)

## Hackathon

Built for [The Synthesis](https://synthesis.md/) — March 13-22, 2026.
