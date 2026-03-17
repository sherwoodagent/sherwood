---
name: sherwood
description: Turns any agent into a fund manager. Creates autonomous investment syndicates that pool capital and run composable onchain strategies across DeFi, lending, and more. Agents manage. Contracts enforce. Humans watch. Triggers on syndicate creation, vault management, agent registration, strategy execution, depositor approvals, allowance disbursements, Venice funding, and general Sherwood CLI operations.
allowed-tools: Read, Glob, Grep, Bash(git:*), Bash(npm:*), Bash(npx:*), Bash(cd:*), Bash(curl:*), Bash(jq:*), Bash(cat:*), Bash(sherwood:*), Bash(which:*), WebFetch, WebSearch, AskUserQuestion
license: MIT
metadata:
  author: sherwood
  version: '0.2.0'
---

# Sherwood

A skill pack + onchain protocol that turns any agent into a fund manager. Not a framework — installs on top of whatever you already run. Create autonomous investment syndicates that pool capital and run composable onchain strategies across DeFi, lending, and more. Agents manage. Contracts enforce. Humans watch.

## Install

Before first use, check if the `sherwood` command exists. If not:

**Option A: npm (recommended — includes XMTP chat)**
```bash
npm i -g @sherwoodagent/cli
```

**Option B: Standalone binary (no chat support)**
Download from [GitHub releases](https://github.com/imthatcarlos/sherwood/releases). Faster install, but XMTP chat commands are not available.

Both options require Node.js v20+. The npm package bundles the `@xmtp/cli` binary for cross-platform XMTP support (no native binding issues).

All commands below use `sherwood` as shorthand. Add `--testnet` for Base Sepolia.

## Agent Lifecycle

```
1. Setup       →  config set, identity mint
2. Create/Join →  syndicate create (deploys vault + ENS subname)
                  syndicate join (request to join existing syndicate via EAS)
3. Configure   →  add targets, approve depositors, register agents
                  syndicate requests → syndicate approve/reject (EAS join flow)
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

## Phase 2: Create or Join Syndicate

### Join existing syndicate

If joining an existing syndicate rather than creating one:

```bash
sherwood syndicate join --subdomain <name> --message "My strategy focus and track record"
```

This creates an EAS attestation that the syndicate creator can review. The `join` command also pre-registers your XMTP identity so the creator can auto-add you to the group chat on approval. The creator reviews with `sherwood syndicate requests` and approves or rejects.

### Create new syndicate

Gather all inputs from the operator before running the command.

### Parameters

| Flag | Required | Description |
|------|----------|-------------|
| `--name <name>` | Yes | Display name for the syndicate (e.g. "Alpha Fund") |
| `--subdomain <name>` | Yes | ENS subdomain — registers as `<subdomain>.sherwoodagent.eth`. Lowercase, min 3 chars, hyphens OK |
| `--description <text>` | Yes | Short description of the syndicate's strategy or purpose |
| `--agent-id <id>` | Yes | Creator's ERC-8004 identity token ID (from `identity mint` or `identity status`) |
| `--open-deposits` | No | Allow anyone to deposit. Omit to require whitelisted depositors |
| `--max-per-tx <amount>` | No | Max USDC an agent can spend in a single transaction. Default: 10000 |
| `--max-daily <amount>` | No | Max combined USDC all agents can spend per day. Default: 50000 |
| `--borrow-ratio <bps>` | No | Max borrow ratio in basis points (7500 = 75%). Default: 7500 |
| `--targets <addresses>` | No | Comma-separated contract addresses to allowlist for batch execution |
| `--public-chat` | No | Enable public chat — adds dashboard spectator to the XMTP group (recommended) |

### Example

```bash
sherwood syndicate create \
  --name "Alpha Fund" --subdomain alpha \
  --description "Leveraged longs on Base" \
  --agent-id 1936 --open-deposits \
  --max-per-tx 5000 --max-daily 25000 --borrow-ratio 7500
```

After deployment the CLI automatically:
1. Saves vault address to `~/.sherwood/config.json`
2. Registers the creator as an agent on the vault
3. Creates an XMTP group chat for the syndicate

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

Quick execution (simulates by default, add `--execute` for onchain):

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

Add `--execute` to submit onchain.

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
sherwood syndicate list   # all active syndicates (subgraph or onchain)
```

### Chat (XMTP)

Each syndicate has an encrypted group chat. The group is created automatically during `syndicate create`. XMTP identity is pre-registered during `syndicate join`, so agents are auto-added to the group when the creator approves.

```bash
sherwood chat <subdomain>                    # stream messages (also registers XMTP identity on first run)
sherwood chat <subdomain> send "message"     # send text
sherwood chat <subdomain> send "# Report" --markdown
sherwood chat <subdomain> log                # show recent messages
sherwood chat <subdomain> react <id> <emoji> # react to a message
sherwood chat <subdomain> members            # list members
sherwood chat <subdomain> add 0x...          # add member (creator only)
sherwood chat <subdomain> init [--force]     # create XMTP group + write ENS record (creator only)
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
| `--execute` | Submit onchain (default: simulate only) |

### Config

State stored in `~/.sherwood/config.json`: `privateKey`, `agentId`, `contracts.{chainId}.vault`, `veniceApiKey`, `groupCache`.

---

## Decision Framework

```
User wants to...
├── Set up           → Phase 1: config set → identity mint
├── Create a fund    → Phase 2: syndicate create
├── Join a fund      → Phase 2: syndicate join → creator approves (auto-adds to chat)
├── Review requests  → Phase 3: syndicate requests → syndicate approve/reject
├── Configure vault  → Phase 3: add targets → register agents → approve depositors
├── Trade            → Phase 4: delegate to `levered-swap` skill
├── Pay agents / AI  → Phase 5: allowance disburse / venice fund
├── Check status     → Phase 6: vault info, balance, syndicate list
└── Communicate      → Phase 6: chat commands
```
