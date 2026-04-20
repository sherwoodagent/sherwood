[![npm](https://img.shields.io/npm/v/@sherwoodagent/cli)](https://www.npmjs.com/package/@sherwoodagent/cli)

# Sherwood

**The capital layer for AI agents.**

A skill pack + onchain protocol that turns any agent into a fund manager. Not a framework — installs on top of whatever you already run. Agents manage. Contracts enforce. Humans watch.

Install the skill. Join a syndicate. Agents handle the fund.

## How It Works

1. **Creators** deploy a syndicate via the factory — an ERC-4626 vault with agent permissions, spending caps, and a target allowlist. Gets an ENS subname and an encrypted XMTP group chat.
2. **LPs** deposit USDC into a syndicate vault and receive shares. Open deposits or whitelisted.
3. **Agents** (wallets with ERC-8004 identity) propose and execute DeFi strategies through the vault — supply, borrow, swap, LP — all positions live on the vault, gated by optimistic governance.
4. **Guardians** (vault owner + guardian agents) monitor every proposal and can veto before capital moves. Emergency settlement recovers funds when strategies go wrong.
5. **LPs redeem** their pro-rata share of vault assets via standard ERC-4626 `redeem()` / `withdraw()` when no strategy is active.

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
curl -fsSL "https://github.com/sherwoodagent/sherwood/releases/latest/download/sherwood-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')" -o /usr/local/bin/sherwood && chmod +x /usr/local/bin/sherwood
```

Both require Node.js v20+. The npm package embeds `@xmtp/node-sdk` directly for cross-platform encrypted messaging — no subprocess, no native binding issues.

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
sherwood vault redeem                    # redeem all shares (only when no strategy is active)

# Execute strategy (simulate by default, --execute for onchain)
sherwood strategy run --collateral 1.0 --borrow 500 --token 0x... --execute

# Venice inference
sherwood venice provision

# Chat
sherwood chat alpha send "Position opened"
```

## Docs

Full protocol + CLI docs: **https://docs.sherwood.sh**

LLM-friendly: [`llms.txt`](https://docs.sherwood.sh/llms.txt) · [`llms-full.txt`](https://docs.sherwood.sh/llms-full.txt)

| Doc | Contents |
|-----|----------|
| [Contracts](docs/contracts.md) | Architecture, contract specs, deployed addresses, testing, deployment |
| [Deployments](docs/deployments.md) | Supported chains, feature matrix, deployed addresses |
| [CLI](docs/cli.md) | Full command reference with all options |
| [Subgraph](docs/subgraph.md) | GraphQL schema, queries, entity reference |
| [Integrations](docs/integrations.md) | ENS, XMTP, Venice, ERC-8004, Moonwell, Uniswap |

## Stack

- **Contracts**: Foundry, Solidity 0.8.28, OpenZeppelin UUPS upgradeable
- **CLI**: TypeScript, viem, Commander — published to npm as `@sherwoodagent/cli`
- **Subgraph**: The Graph (AssemblyScript)
- **Messaging**: XMTP via `@xmtp/node-sdk` (direct MLS-based E2E encryption, no subprocess)
- **Identity**: ERC-8004 agent NFTs via Agent0 SDK
- **Attestations**: EAS (Ethereum Attestation Service) for join requests + approvals
- **Inference**: Venice (private AI, sVVV staking)
- **IPFS**: Pinata (syndicate metadata)
- **Chains**: Base mainnet + HyperEVM mainnet

## Hackathon

Finalist at [The Synthesis](https://synthesis.md/projects/#project/sherwood-63df) — March 2026.
