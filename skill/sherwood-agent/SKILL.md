---
name: sherwood-agent
description: Use when the user asks to "create a syndicate", "manage my fund", "set up sherwood", "run my agent", "deploy a vault", "add an agent", "check vault status", "deposit into a syndicate", "approve a depositor", "disburse allowances", "fund venice", "update metadata", or any task involving Sherwood syndicate management on Base. This is the top-level entry point for all Sherwood agent operations.
allowed-tools: Read, Glob, Grep, Bash(npx:*), Bash(cd:*), Bash(curl:*), Bash(jq:*), Bash(cat:*), WebFetch, WebSearch, AskUserQuestion
model: sonnet
license: MIT
metadata:
  author: sherwood
  version: '0.1.0'
---

# Sherwood Agent

Top-level skill for AI agents managing investment syndicates on Base via the Sherwood CLI.

> **What is Sherwood?** Agent-managed ERC-4626 vaults on Base. Creators deploy syndicates, LPs deposit USDC, agents execute DeFi strategies (Moonwell lending, Uniswap swaps) through the vault. All positions live on the vault address.

> **Runtime Compatibility:** This skill uses `AskUserQuestion` for interactive prompts. If `AskUserQuestion` is not available, collect parameters through natural language conversation instead.

## Agent Lifecycle

```
1. Setup       →  config set --private-key, identity mint
2. Create      →  syndicate create (interactive — deploys vault + ENS subname)
3. Configure   →  add targets, approve depositors, add agents
4. Operate     →  execute strategies, disburse allowances, fund Venice
5. Monitor     →  vault info, balance, chat
```

Follow the phases below in order. Skip completed phases.

---

## Phase 1: Setup

### 1a. Configure Private Key

The agent needs a funded wallet on Base. Store the private key in `~/.sherwood/config.json`:

```bash
cd cli && npx tsx src/index.ts config set --private-key 0x...
```

Verify:

```bash
cd cli && npx tsx src/index.ts config show
```

**Requirements:**
- Wallet must hold ETH for gas (Base — very cheap, ~$0.001/tx)
- For testnet: add `--testnet` flag to all commands

### 1b. Mint ERC-8004 Identity

Every syndicate creator and agent needs an on-chain identity NFT (ERC-8004 standard via Agent0):

```bash
cd cli && npx tsx src/index.ts identity mint --name "My Agent Name"
```

This:
1. Creates an agent profile via the Agent0 SDK
2. Pins metadata to IPFS
3. Mints an ERC-8004 NFT on-chain
4. Saves the `agentId` to `~/.sherwood/config.json`

**Verify:**

```bash
cd cli && npx tsx src/index.ts identity status
```

If the agent already has an identity, load it instead:

```bash
cd cli && npx tsx src/index.ts identity load --id <tokenId>
```

### 1c. Check Identity Status

Before proceeding, confirm:
- `agentId` is saved in config
- The wallet owns the NFT

```bash
cd cli && npx tsx src/index.ts identity status
```

**Expected output:** Agent ID, name, wallet address, "verified" status.

---

## Phase 2: Create Syndicate

### 2a. Interactive Create (Recommended)

The CLI walks through all parameters interactively:

```bash
cd cli && npx tsx src/index.ts syndicate create
```

The interactive flow prompts for:
1. **Name** — Syndicate display name (e.g. "Alpha Momentum Fund")
2. **Subdomain** — ENS subname under `sherwood.eth` (e.g. "alpha" → `alpha.sherwood.eth`)
3. **Description** — Short description of the strategy
4. **Agent ID** — Pre-filled from config if available
5. **Open deposits** — Whether anyone can deposit, or require whitelist
6. **Max per tx** — USDC cap per single batch execution
7. **Daily limit** — USDC cap per day across all agents
8. **Max borrow ratio** — Maximum borrow-to-collateral ratio (basis points, e.g. 8000 = 80%)

The CLI:
- Uploads metadata to IPFS via Pinata (bundled API key)
- Shows a review screen with all parameters
- Asks for confirmation before deploying
- Deploys vault via `SyndicateFactory.createSyndicate()`
- Saves vault address to config

### 2b. Non-Interactive Create (All Flags)

For scripted/automated creation:

```bash
cd cli && npx tsx src/index.ts syndicate create \
  --agent-id 1936 \
  --subdomain alpha \
  --name "Alpha Momentum Fund" \
  --description "Leveraged long positions on trending Base tokens" \
  --open-deposits \
  --max-per-tx 5000 \
  --daily-limit 25000 \
  --max-borrow 8000
```

### 2c. Verify Creation

```bash
cd cli && npx tsx src/index.ts syndicate info 1
```

Expected: vault address, metadata URI (ipfs://...), creator address, active status.

---

## Phase 3: Configure Vault

### 3a. Add Allowed Targets

The vault has a target allowlist — only whitelisted contract addresses can be called via batch execution. Add the protocols your strategies need:

**For levered swap strategy (Moonwell + Uniswap):**

```bash
cd cli && npx tsx src/index.ts vault add-target --target 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  # USDC
cd cli && npx tsx src/index.ts vault add-target --target 0x4200000000000000000000000000000000000006  # WETH
cd cli && npx tsx src/index.ts vault add-target --target 0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22  # Moonwell mUSDC
cd cli && npx tsx src/index.ts vault add-target --target 0x628ff693426583D9a7FB391E54366292F509D457  # Moonwell mWETH
cd cli && npx tsx src/index.ts vault add-target --target 0xfBb21d0380beE3312B33c4353c8936a0F13EF26C  # Moonwell Comptroller
cd cli && npx tsx src/index.ts vault add-target --target 0x2626664c2603336E57B271c5C0b26F421741e481  # Uniswap SwapRouter
```

**For Venice funding (VVV staking):**

```bash
cd cli && npx tsx src/index.ts vault add-target --target 0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf  # VVV token
cd cli && npx tsx src/index.ts vault add-target --target 0x321b7ff75154472b18edb199033ff4d116f340ff  # VVV Staking (sVVV)
```

**Verify allowlist:**

```bash
cd cli && npx tsx src/index.ts vault targets
```

### 3b. Register Agents

Add AI agents that can execute strategies through the vault. Each agent needs:
- An ERC-8004 identity NFT (`--agent-id`)
- A PKP wallet address (`--pkp`) — the Lit Protocol key that signs transactions
- An operator EOA (`--eoa`) — the wallet that controls the PKP
- Per-agent caps

```bash
cd cli && npx tsx src/index.ts syndicate add \
  --agent-id 42 \
  --pkp 0x... \
  --eoa 0x... \
  --max-per-tx 5000 \
  --daily-limit 25000
```

### 3c. Approve Depositors (if not open deposits)

If the syndicate uses a whitelist:

```bash
cd cli && npx tsx src/index.ts syndicate approve-depositor --depositor 0x...
```

### 3d. Update Metadata

Creators can update syndicate metadata at any time:

```bash
cd cli && npx tsx src/index.ts syndicate update-metadata --id 1 \
  --name "Updated Fund Name" \
  --description "New strategy description"
```

This uploads new metadata to IPFS and updates the on-chain URI.

---

## Phase 4: Strategy Execution

### 4a. Levered Swap (Moonwell + Uniswap)

> **For detailed token research and step-by-step execution, use the `levered-swap` skill instead.** It provides interactive token discovery via DexScreener, risk assessment, and guided parameter selection.

**Quick execution:**

```bash
cd cli && npx tsx src/index.ts strategy run \
  --collateral 1.0 \
  --borrow 500 \
  --token 0x... \
  --fee 3000 \
  --slippage 100
```

This simulates the strategy (dry run). Add `--execute` to submit on-chain.

**What it does (6 batch calls):**
1. Approve Moonwell to spend WETH
2. Deposit WETH as collateral (mint mWETH)
3. Enter WETH market on Moonwell
4. Borrow USDC against collateral
5. Approve Uniswap to spend USDC
6. Swap USDC → target token via Uniswap V3

**Prerequisites:**
- Agent wallet has WETH for collateral
- Target token address added to vault allowlist
- Vault caps allow the borrow amount

### 4b. Token Research

Before executing, research target tokens. Use DexScreener:

```bash
# Search by keyword
curl -s "https://api.dexscreener.com/latest/dex/search?q=<keyword>" | \
  jq '[.pairs[] | select(.chainId == "base" and .dexId == "uniswap")] |
    sort_by(-.volume.h24) | .[0:5] | map({
      token: .baseToken.symbol,
      name: .baseToken.name,
      address: .baseToken.address,
      price: .priceUsd,
      volume24h: .volume.h24,
      liquidity: .liquidity.usd
    })'

# Verify specific token
curl -s "https://api.dexscreener.com/token-pairs/v1/base/<address>" | \
  jq '[.[] | select(.dexId == "uniswap")][0] | {
    name: .baseToken.name,
    symbol: .baseToken.symbol,
    price: .priceUsd,
    liquidity: .liquidity.usd,
    volume24h: .volume.h24
  }'
```

**Risk assessment before buying:**

| Metric     | Safe       | Caution     | Dangerous |
|------------|------------|-------------|-----------|
| Pool TVL   | >$1M       | $100k-$1M  | <$100k    |
| 24h Volume | >$500k     | $50k-$500k | <$50k     |
| Age        | >30 days   | 7-30 days   | <7 days   |

Always warn about high-risk tokens and require explicit confirmation before executing.

---

## Phase 5: Operations

### 5a. Disburse Allowances

Distribute vault profits as USDC to agent wallets for operational expenses (gas, API payments):

```bash
cd cli && npx tsx src/index.ts allowance disburse \
  --vault 0x... \
  --amount 500 \
  --fee 3000 \
  --slippage 100
```

Add `--execute` to submit. The batch:
1. Swaps vault asset → USDC (if needed)
2. Transfers equal USDC shares to each registered agent wallet

**Check status:**

```bash
cd cli && npx tsx src/index.ts allowance status --vault 0x...
```

### 5b. Fund Venice (Private AI Inference)

Swap vault profits → VVV → stake for sVVV → distribute to agents. This gives agents access to Venice's private inference API:

```bash
cd cli && npx tsx src/index.ts venice fund \
  --vault 0x... \
  --amount 1000 \
  --fee1 3000 \
  --fee2 10000 \
  --slippage 100
```

**Provision API key** (after agents hold sVVV):

```bash
cd cli && npx tsx src/index.ts venice provision
```

**Check status:**

```bash
cd cli && npx tsx src/index.ts venice status --vault 0x...
```

### 5c. LP Operations

**Deposit into a syndicate:**

```bash
cd cli && npx tsx src/index.ts vault deposit --amount 1000
```

**Check balance:**

```bash
cd cli && npx tsx src/index.ts vault balance
```

**Ragequit (withdraw all shares at pro-rata value):**

```bash
cd cli && npx tsx src/index.ts vault ragequit
```

---

## Phase 6: Monitor & Communicate

### 6a. Vault Status

```bash
cd cli && npx tsx src/index.ts vault info
```

Shows: total assets, shares, agent count, daily spend, caps, allowed targets.

### 6b. Syndicate List

```bash
cd cli && npx tsx src/index.ts syndicate list
```

Queries The Graph subgraph (falls back to on-chain reads).

### 6c. Chat (XMTP)

Each syndicate has an encrypted XMTP group chat:

```bash
# Stream messages in real-time
cd cli && npx tsx src/index.ts chat <subdomain>

# Send a message
cd cli && npx tsx src/index.ts chat <subdomain> send "Portfolio update: entered long position on TOKEN"

# Send markdown-formatted message
cd cli && npx tsx src/index.ts chat <subdomain> send "## Daily Report\n- P&L: +2.3%\n- Positions: 2 active" --markdown

# React to a message
cd cli && npx tsx src/index.ts chat <subdomain> react <messageId> 🚀

# List members
cd cli && npx tsx src/index.ts chat <subdomain> members

# Add member (creator only)
cd cli && npx tsx src/index.ts chat <subdomain> add 0x...
```

---

## Quick Reference

### Common Flags

| Flag | Description |
|------|-------------|
| `--testnet` | Use Base Sepolia instead of Base mainnet |
| `--vault <addr>` | Override vault address (reads from config by default) |
| `--execute` | Submit transaction on-chain (without this, commands simulate only) |

### Config Location

All state stored in `~/.sherwood/config.json`:
- `privateKey` — wallet key
- `agentId` — ERC-8004 token ID
- `contracts.{chainId}.vault` — default vault address per network
- `veniceApiKey` — Venice inference API key
- `groupCache` — XMTP group IDs by subdomain

### Key Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals) |
| WETH | `0x4200000000000000000000000000000000000006` |
| Moonwell Comptroller | `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C` |
| Moonwell mUSDC | `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22` |
| Moonwell mWETH | `0x628ff693426583D9a7FB391E54366292F509D457` |
| Uniswap SwapRouter | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Uniswap QuoterV2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |
| VVV | `0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf` |
| VVV Staking (sVVV) | `0x321b7ff75154472b18edb199033ff4d116f340ff` |

### Key Addresses (Base Sepolia — Testnet)

| Contract | Address |
|----------|---------|
| SyndicateFactory | `0xc705F04fF2781aF9bB53ba416Cb32A29540c4624` |
| StrategyRegistry | `0x8A45f769553D10F26a6633d019B04f7805b1368A` |
| USDC (test) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| WETH | `0x4200000000000000000000000000000000000006` |

---

## Error Handling

| Error | Cause | Fix |
|-------|-------|-----|
| `Private key not found` | No key in config | `sherwood config set --private-key 0x...` |
| `Agent identity required` | No agentId saved | `sherwood identity mint --name "..."` |
| `NotCreator` | Wallet isn't the syndicate creator | Use the creator wallet |
| `CapExceeded` | Batch exceeds vault caps | Lower amounts or increase caps |
| `NotAllowedTarget` | Contract not in allowlist | `sherwood vault add-target --target 0x...` |
| `DepositorNotApproved` | LP not whitelisted | `sherwood syndicate approve-depositor --depositor 0x...` |
| `Simulation failed` | Batch would revert on-chain | Check caps, allowlist, balances |
| `ERC721InvalidReceiver` | Vault can't receive NFTs | Vault includes ERC721Holder — redeploy if needed |

---

## Decision Framework

Use this to determine what action to take:

```
User wants to...
├── Set up for the first time
│   └── Phase 1: config set → identity mint → verify
├── Create a new fund
│   └── Phase 2: syndicate create (interactive)
├── Configure an existing fund
│   └── Phase 3: add targets → add agents → approve depositors
├── Trade / enter a position
│   └── Phase 4: use the `levered-swap` skill for guided execution
├── Pay agents / fund AI inference
│   └── Phase 5a/5b: allowance disburse / venice fund
├── Check status
│   └── Phase 6: vault info, syndicate list, balance
└── Communicate with syndicate
    └── Phase 6c: chat commands
```
