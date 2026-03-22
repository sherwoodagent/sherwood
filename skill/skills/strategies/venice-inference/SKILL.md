---
name: venice-inference
description: Venice VVV staking and private inference via governance proposals — swap or receive VVV, stake for sVVV, provision API key, run inference, settle with unstake + cooldown claim
allowed-tools: Read, Glob, Grep, Bash(sherwood *), Bash(npm *), Bash(npx *), WebFetch, WebSearch, AskUserQuestion
model: sonnet
license: MIT
metadata:
  author: sherwood
  version: '0.1.0'
---

# Venice Inference Strategy

Stake VVV for sVVV to enable private AI inference via Venice. Uses `VeniceInferenceStrategy` (ERC-1167 clonable) — any syndicate, any agent, any proposal can use it as a lego block.

## Overview

```
Vault (holds USDC or VVV)
    ↓ governance proposal
VeniceInferenceStrategy clone
    ↓ execute: pull asset → [swap via Aerodrome if needed] → stake VVV → agent gets sVVV
Agent wallet (holds sVVV)
    ↓ provision API key (EIP-191 signature)
Venice private inference (chat completions)
    ↓ settle: claw back sVVV → initiate unstake → cooldown → claimVVV → VVV back to vault
```

## Two Execution Paths

The strategy supports both paths, determined by `asset` vs `vvv` in InitParams:

### Direct Path (asset == VVV)
Vault already holds VVV (e.g., from a prior swap or deposit). Strategy pulls VVV and stakes directly.

### Swap Path (asset != VVV)
Vault holds USDC or another asset. Strategy swaps to VVV via Aerodrome Router, then stakes.
- Single-hop: asset → VVV
- Multi-hop: asset → WETH → VVV

## Workflow

### Step 1: Prerequisites

```bash
# Confirm agent wallet is configured
sherwood config show

# Confirm agent has ERC-8004 identity
sherwood identity show

# Confirm agent is registered in the syndicate vault
sherwood vault info --vault <vault-address>
```

### Step 2: Clone + init + build calls (all-in-one)

The `strategy propose` command handles everything: clones the template, initializes it, builds batch calls, and optionally submits the proposal.

```bash
# Generate execute/settle JSON files (clone + init happens on-chain)
sherwood strategy propose venice-inference \
  --vault <vault-address> \
  --amount 500 \
  --asset USDC \
  --min-vvv 900 \
  --write-calls ./venice-calls

# Submit the proposal
sherwood proposal create \
  --vault <vault-address> \
  --name "Venice VVV Staking" \
  --performance-fee 0 \
  --duration 7d \
  --execute-calls ./venice-calls/execute.json \
  --settle-calls ./venice-calls/settle.json
```

Or submit directly (skip `--write-calls`):

```bash
sherwood strategy propose venice-inference \
  --vault <vault-address> \
  --amount 500 --asset USDC --min-vvv 900 \
  --name "Venice VVV Staking" --performance-fee 0 --duration 7d
```

The CLI prints the clone address after deployment. Use it for the pre-approval step.

### Step 3: Pre-approve sVVV clawback

The agent must approve the strategy clone to claw back sVVV on settlement. ERC20 approve works before holding tokens.

```bash
# Agent calls sVVV.approve(strategyClone, type(uint256).max) from their wallet
# The clone address is printed by `strategy propose`
```

### Step 4: Provision API key

After proposal executes and agent holds sVVV:

```bash
sherwood venice provision
```

This:
1. GETs a validation token from Venice API
2. Signs it with the agent wallet (EIP-191)
3. POSTs the signature to generate an INFERENCE API key
4. Saves key to `~/.sherwood/config.json`

Requires the signing wallet to hold sVVV. Venice does not support EIP-1271 (contract signatures).

### Step 5: Run private inference

```bash
# List available models
sherwood venice models

# Basic inference
sherwood venice infer --model <model-id> --prompt "Analyze the current yield landscape on Base"

# With web search enabled
sherwood venice infer --model <model-id> --prompt "Latest DeFi developments" --web-search

# With data context (e.g., vault state, market data)
sherwood venice infer --model <model-id> --data ./market-data.json --prompt "Given this data, what strategy should we pursue?"

# With system prompt for agent personality
sherwood venice infer --model <model-id> \
  --system "You are a DeFi strategy researcher. Be concise and data-driven." \
  --prompt "Evaluate Moonwell USDC supply rates vs Aerodrome LP yields"

# Raw JSON output for programmatic use
sherwood venice infer --model <model-id> --prompt "..." --json
```

### Step 6: Use inference to generate next strategy

The goal of Venice inference is to do more reasoning on data to determine a new strategy. Example flow:

1. Collect vault state + market data
2. Run inference to analyze opportunities
3. Generate a new proposal based on inference output
4. Submit the new proposal through governance

```bash
# Collect data
sherwood vault info --vault <vault> --json > ./vault-state.json

# Reason about next move
sherwood venice infer --model deepseek-r1-671b \
  --data ./vault-state.json \
  --system "You are analyzing a DeFi vault. Suggest the next strategy." \
  --prompt "Given vault state, what's the best yield opportunity? Consider Moonwell supply, Aerodrome LP, and market conditions."

# Act on the inference output to create next proposal
```

### Step 7: Settlement

When the strategy duration expires:

```bash
# Settle the proposal (claws back sVVV, initiates unstake)
sherwood proposal settle --id <proposal-id>
```

Settlement calls `strategy.settle()` which:
1. Pulls sVVV from agent via `transferFrom` (pre-approved in step 3)
2. Calls `initiateUnstake(stakedAmount)` on Venice staking — cooldown begins
3. After cooldown elapses, anyone calls `strategy.claimVVV()` to finalize unstake and push VVV back to vault

### Step 8: Check status

```bash
sherwood venice status --vault <vault-address>
```

Shows: vault profit, VVV balance, per-agent sVVV balances, pending rewards, API key validity.

## Contract Details

### InitParams

| Field | Type | Description |
|-------|------|-------------|
| `asset` | `address` | Token pulled from vault (VVV for direct, USDC etc. for swap) |
| `weth` | `address` | Intermediate token for multi-hop (ignored if direct or singleHop) |
| `vvv` | `address` | VVV token |
| `sVVV` | `address` | Venice staking contract (also the sVVV ERC-20) |
| `aeroRouter` | `address` | Aerodrome router (address(0) if direct path) |
| `aeroFactory` | `address` | Aerodrome factory (address(0) if direct path) |
| `agent` | `address` | Agent wallet receiving sVVV |
| `assetAmount` | `uint256` | Amount of asset to pull from vault |
| `minVVV` | `uint256` | Min VVV output from swap (0 if direct) |
| `deadlineOffset` | `uint256` | Seconds for swap deadline (default 300) |
| `singleHop` | `bool` | True for direct asset→VVV swap |

### Lifecycle

```
Pending → execute() → Executed → settle() → Settled → claimVVV() → VVV returned to vault
```

- `needsSwap()`: returns `true` when `asset != vvv`
- `claimVVV()`: public, callable by anyone after settlement + cooldown
- Tunable params (proposer only, while Executed): `minVVV`, `deadlineOffset`

## Governor Integration

- **Allowlisting:** The vault must allowlist the strategy clone address, VVV token, sVVV staking contract, and Aerodrome Router (swap path only) as batch targets via `sherwood vault add-target`. Without this, `executeGovernorBatch` will revert.
- **Gas costs:** The proposer (agent) pays gas for clone deployment + initialization. The governor pays gas for proposal execution and settlement.
- **updateParams():** Callable directly by the proposer while strategy is in Executed state. No governance proposal needed. Useful for adjusting swap slippage (`minVVV`) or deadline if market conditions change.
- **Post-settlement claim:** Unlike Moonwell, Venice staking has a cooldown period. After `settle()` initiates the unstake, anyone can call `claimVVV()` on the strategy clone once the cooldown elapses — no governance needed, no access control. VVV flows back to the vault.
- **Pre-approval:** The agent must call `sVVV.approve(strategyClone, amount)` before the proposal is created. This is a direct ERC20 approval — no governance needed, and it works before the agent holds any sVVV.

## Key Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| VVV Token | `0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf` |
| Venice Staking (sVVV) | `0x321b7ff75154472b18edb199033ff4d116f340ff` |
| DIEM | `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024` |
| Aerodrome Router | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
| Aerodrome Factory | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH | `0x4200000000000000000000000000000000000006` |

## Required Allowlist Targets

For governance proposals using VeniceInferenceStrategy:

- Vault's deposit token (e.g., USDC)
- VVV Token
- Venice Staking (sVVV)
- Aerodrome Router (if swap path)
- Strategy clone address
