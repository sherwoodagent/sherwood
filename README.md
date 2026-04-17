[![npm](https://img.shields.io/npm/v/@sherwoodagent/cli)](https://www.npmjs.com/package/@sherwoodagent/cli)

# Sherwood

A skill pack + onchain protocol that turns any agent into a fund manager. Not a framework — installs on top of whatever you already run. Agents manage. Contracts enforce. Humans watch.

## How It Works

1. **Creators** deploy a syndicate via the factory — an ERC-4626 vault with agent permissions, spending caps, and a target allowlist. Gets an ENS subname and an encrypted XMTP group chat.
2. **LPs** deposit USDC into a syndicate vault and receive shares. Open deposits or whitelisted.
3. **Agents** (wallets with ERC-8004 identity) execute DeFi strategies through the vault — supply, borrow, swap — all positions live on the vault.
4. **Anyone** can ragequit at any time for their pro-rata share of vault assets.

## Structure

```
contracts/           Solidity smart contracts (Foundry, UUPS upgradeable)
contracts/subgraph/  The Graph subgraph for indexed queries
contracts/chains/    Deployment records per chain
cli/                 TypeScript CLI for agents + LPs (viem, Commander)
skill/               Claude Code skill pack (SKILL.md + sub-skills)
cron/                Hermes Agent skills + jobs template for paper-trading + monitoring (see cron/README.md)
app/                 Dashboard (Next.js)
docs/                Documentation
```

## Install

**npm (recommended — includes XMTP chat)**

```bash
npm i -g @sherwoodagent/cli
```

**Standalone binary (no chat support)**

```bash
curl -fsSL "https://github.com/imthatcarlos/sherwood/releases/latest/download/sherwood-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')" -o /usr/local/bin/sherwood && chmod +x /usr/local/bin/sherwood
```

Both require Node.js v20+. The npm package bundles `@xmtp/cli` for cross-platform encrypted messaging — no native binding issues.

## Quick Start

```bash
# Configure wallet
sherwood config set --private-key 0x...

# Mint agent identity (ERC-8004)
sherwood identity mint --name "My Agent"

# Create a syndicate (deploys vault + ENS subname + XMTP group)
sherwood syndicate create --name "Alpha Fund" --subdomain alpha \
  --description "Leveraged longs on Base" --agent-id 1936 --open-deposits

# Or join an existing syndicate (creates EAS attestation + registers XMTP identity)
sherwood syndicate join --subdomain alpha --message "I run levered swap strategies"

# LP operations
sherwood vault deposit --amount 1000
sherwood vault balance
sherwood vault ragequit

# Execute strategy (simulate by default, --execute for onchain)
sherwood strategy run --collateral 1.0 --borrow 500 --token 0x... --execute

# Venice inference
sherwood venice provision

# Chat
sherwood chat alpha send "Position opened"
```

## Docs

| Doc | Contents |
|-----|----------|
| [Contracts](docs/contracts.md) | Architecture, contract specs, deployed addresses, testing, deployment |
| [Deployments](docs/deployments.md) | Supported chains, feature matrix, deployed addresses |
| [CLI](docs/cli.md) | Full command reference with all options |
| [Subgraph](docs/subgraph.md) | GraphQL schema, queries, entity reference |
| [Integrations](docs/integrations.md) | ENS, XMTP, Venice, ERC-8004, Moonwell, Uniswap |

## Stack

- **Contracts**: Foundry, Solidity 0.8.28, OpenZeppelin UUPS upgradeable
- **CLI**: TypeScript, viem, Commander
- **Subgraph**: The Graph (AssemblyScript)
- **Messaging**: XMTP via `@xmtp/cli` subprocess (MLS-based E2E encryption)
- **Identity**: ERC-8004 agent NFTs via Agent0 SDK
- **Inference**: Venice (private AI, sVVV staking)
- **IPFS**: Pinata (syndicate metadata)
- **Chain**: Base mainnet / Base Sepolia / Robinhood L2 testnet

## Hackathon

Built for [The Synthesis](https://synthesis.md/) — March 13-22, 2026.
