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

- **SyndicateVault** — ERC-4626 vault with delegatecall execution, ERC721Holder (receives ENS subname NFTs). Two-layer permissions (syndicate caps + per-agent caps). Depositor whitelist. Ragequit.
- **SyndicateFactory** — Deploys vault proxies. Registers ENS subnames. ERC-8004 agent identity verification.
- **BatchExecutorLib** — Shared stateless library for batched protocol calls (supply, borrow, swap). Target allowlist.
- **StrategyRegistry** — On-chain strategy catalog with creator tracking.

66 tests passing. See [contracts/README.md](contracts/README.md) for build, test, deploy instructions.

## CLI

TypeScript CLI for syndicate management, LP operations, and strategy execution.

```bash
cd cli && npm install

# Setup — private key stored in ~/.sherwood/config.json
sherwood config set --private-key 0x...

# Identity — mint ERC-8004 agent NFT (required before syndicate create)
sherwood identity mint --name "My Agent"
sherwood identity status

# Syndicate management — vault address auto-saved to config after create
sherwood syndicate create --agent-id 1936 --subdomain my-fund --name "My Fund" --open-deposits
sherwood syndicate list                          # Queries subgraph (or on-chain fallback)
sherwood syndicate info 1                        # Vault stats + metadata
sherwood syndicate approve-depositor --depositor 0x...

# LP operations — --vault flag is optional (reads from config)
sherwood vault deposit --amount 1000
sherwood vault balance
sherwood vault ragequit

# Strategy execution
sherwood strategy run --collateral 1.0 --borrow 500 --token 0x... --execute

# Vault admin
sherwood vault info
sherwood vault add-target --target 0x...
sherwood syndicate add --agent-id 42 --pkp 0x... --eoa 0x... --max-per-tx 5000 --daily-limit 25000
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
