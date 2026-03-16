---
name: sherwood-agent
description: Manages Sherwood investment syndicates on Base — creates vaults, configures agents, executes DeFi strategies, disburses allowances, and funds Venice inference. Triggers on syndicate creation, vault management, agent registration, strategy execution, depositor approvals, allowance disbursements, Venice funding, metadata updates, and general Sherwood CLI operations.
allowed-tools: Read, Glob, Grep, Bash(npx:*), Bash(cd:*), Bash(curl:*), Bash(jq:*), Bash(cat:*), WebFetch, WebSearch, AskUserQuestion
model: sonnet
license: MIT
metadata:
  author: sherwood
  version: '0.2.0'
---

# Sherwood Agent

Manages agent-operated ERC-4626 investment vaults on Base via the Sherwood CLI.

All commands run from the `cli/` directory: `cd cli && npx tsx src/index.ts <command>` (abbreviated as `sherwood` below). Add `--testnet` for Base Sepolia.

## Agent Lifecycle

```
1. Setup       →  config set, identity mint
2. Create      →  syndicate create (deploys vault + ENS subname)
3. Configure   →  add targets, approve depositors, register agents
4. Operate     →  execute strategies, disburse allowances, fund Venice
5. Monitor     →  vault info, balance, chat
```

Follow phases in order. Skip completed phases.

---

## Phase 1: Setup

### Configure wallet

```bash
sherwood config set --private-key 0x...
sherwood config show  # verify
```

Wallet must hold ETH on Base for gas.

### Mint ERC-8004 identity

Required before creating or joining syndicates:

```bash
sherwood identity mint --name "My Agent Name"
sherwood identity status  # verify: shows agent ID, owner, "verified"
```

Saves `agentId` to `~/.sherwood/config.json`. To load an existing identity: `sherwood identity load --id <tokenId>`.

---

## Phase 2: Create Syndicate

### Interactive (recommended)

```bash
sherwood syndicate create
```

Prompts for: name, subdomain (ENS), description, agent ID, open deposits, caps (max per tx, daily limit, max borrow ratio). Uploads metadata to IPFS, shows review screen, deploys on confirmation. Vault address auto-saved to config.

### Non-interactive

```bash
sherwood syndicate create \
  --agent-id 1936 --subdomain alpha --name "Alpha Fund" \
  --description "Leveraged longs on Base" --open-deposits \
  --max-per-tx 5000 --daily-limit 25000 --max-borrow 8000
```

Verify: `sherwood syndicate info 1`

---

## Phase 3: Configure Vault

### Add allowed targets

Only whitelisted addresses can be called via batch execution. See [ADDRESSES.md](ADDRESSES.md) for per-strategy target lists.

```bash
sherwood vault add-target --target <address>
sherwood vault targets  # verify
```

### Register agents

```bash
sherwood syndicate add \
  --agent-id 42 --pkp 0x... --eoa 0x... \
  --max-per-tx 5000 --daily-limit 25000
```

### Approve depositors

If not using open deposits: `sherwood syndicate approve-depositor --depositor 0x...`

### Update metadata

```bash
sherwood syndicate update-metadata --id 1 --name "New Name" --description "Updated"
```

---

## Phase 4: Strategy Execution

### Levered swap (Moonwell + Uniswap)

> For guided token research and step-by-step execution, delegate to the **`levered-swap` skill**.

Quick execution (simulates by default, add `--execute` for on-chain):

```bash
sherwood strategy run \
  --collateral 1.0 --borrow 500 --token 0x... \
  --fee 3000 --slippage 100
```

Prerequisites: agent has WETH, target token in vault allowlist, caps allow borrow amount.

---

## Phase 5: Operations

### Disburse allowances

Distributes vault profits as USDC to agent wallets:

```bash
sherwood allowance disburse --amount 500 --fee 3000 --slippage 100
sherwood allowance status  # check balances
```

Add `--execute` to submit on-chain.

### Fund Venice (private AI inference)

Swaps vault profits to VVV, stakes for sVVV, distributes to agents:

```bash
sherwood venice fund --amount 1000 --fee1 3000 --fee2 10000 --slippage 100
sherwood venice provision  # self-provision API key (requires sVVV)
sherwood venice status     # check sVVV balances + API key
```

### LP operations

```bash
sherwood vault deposit --amount 1000
sherwood vault balance
sherwood vault ragequit  # withdraw all shares at pro-rata value
```

---

## Phase 6: Monitor & Communicate

```bash
sherwood vault info       # assets, agents, daily spend, caps
sherwood syndicate list   # all active syndicates (subgraph or on-chain)
```

### Chat (XMTP)

Each syndicate has an encrypted group chat:

```bash
sherwood chat <subdomain>                    # stream messages
sherwood chat <subdomain> send "message"     # send text
sherwood chat <subdomain> send "# Report" --markdown
sherwood chat <subdomain> members            # list members
sherwood chat <subdomain> add 0x...          # add member (creator only)
```

---

## Reference

| Resource | Content |
|----------|---------|
| [ADDRESSES.md](ADDRESSES.md) | Contract addresses (mainnet + testnet) and per-strategy allowlist targets |
| [ERRORS.md](ERRORS.md) | Common errors, causes, and fixes |
| `cli/src/lib/addresses.ts` | Canonical address source (resolved at runtime by network) |
| `cli/src/commands/` | Command implementations for each subcommand group |

### Key flags

| Flag | Effect |
|------|--------|
| `--testnet` | Use Base Sepolia |
| `--vault <addr>` | Override vault (default: from config) |
| `--execute` | Submit on-chain (default: simulate only) |

### Config

State stored in `~/.sherwood/config.json`: `privateKey`, `agentId`, `contracts.{chainId}.vault`, `veniceApiKey`, `groupCache`.

---

## Decision Framework

```
User wants to...
├── Set up           → Phase 1: config set → identity mint
├── Create a fund    → Phase 2: syndicate create
├── Configure vault  → Phase 3: add targets → register agents → approve depositors
├── Trade            → Phase 4: delegate to `levered-swap` skill
├── Pay agents / AI  → Phase 5: allowance disburse / venice fund
├── Check status     → Phase 6: vault info, balance, syndicate list
└── Communicate      → Phase 6: chat commands
```
