---
name: venice-inference
description: Venice VVV staking loan model — vault lends asset to agent for private inference, agent repays principal + profit from off-chain strategy
allowed-tools: Read, Glob, Grep, Bash(sherwood *), Bash(npm *), Bash(npx *), WebFetch, WebSearch, AskUserQuestion
model: sonnet
license: MIT
metadata:
  author: sherwood
  version: '0.2.0'
---

# Venice Inference Strategy

Loan-model strategy: vault lends asset to an agent for Venice private inference. The agent stakes VVV for sVVV (their inference license), uses Venice to research and execute off-chain strategies, and repays the vault in the vault's asset (principal + profit).

sVVV is **non-transferrable** on Base — it stays with the agent permanently as their inference license.

## Overview

```
Vault (holds USDC or VVV)
    ↓ governance proposal (the "loan")
VeniceInferenceStrategy clone
    ↓ execute: pull asset → [swap via Aerodrome if needed] → stake VVV → agent gets sVVV
Agent wallet (holds sVVV permanently)
    ↓ provision API key (EIP-191 signature)
Venice private inference (chat completions, reasoning)
    ↓ agent executes off-chain strategy, earns profit
    ↓ settle: agent repays vault in vault asset (principal + profit)
Vault (recovers principal + profit, fees distributed)
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
  --name "Venice Inference Loan" \
  --description "Loan 500 USDC for VVV staking + private inference. Will repay principal + trading profit." \
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
  --name "Venice Inference Loan" --performance-fee 0 --duration 7d
```

### Step 3: Provision API key

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

### Step 4: Run private inference

```bash
# List available models
sherwood venice models

# Basic inference
sherwood venice infer --model <model-id> --prompt "Analyze the current yield landscape on Base"

# With data context (e.g., vault state, market data)
sherwood venice infer --model <model-id> --data ./market-data.json --prompt "Given this data, what strategy should we pursue?"

# With system prompt for agent personality
sherwood venice infer --model <model-id> \
  --system "You are a DeFi strategy researcher. Be concise and data-driven." \
  --prompt "Evaluate Moonwell USDC supply rates vs Aerodrome LP yields"
```

### Step 5: Execute off-chain strategy

The goal of Venice inference is reasoning on data to find alpha. Example flow:

1. Collect vault state + market data
2. Run inference to analyze opportunities
3. Execute trades or strategies off-chain based on inference output
4. Earn profit in the vault's asset (e.g., USDC)

### Step 6: Repay and settle

Before settlement, the agent must:
1. Set repayment amount (principal + profit) via `updateParams()`
2. Approve the strategy clone to pull the repayment from their wallet

```bash
# Agent updates repaymentAmount to include profit
# Encode: (uint256 newRepayment, uint256 newMinVVV, uint256 newDeadlineOffset)
# Pass 0 for unchanged fields
```

Then settle:

```bash
sherwood proposal settle --id <proposal-id>
```

Settlement calls `strategy.settle()` which:
1. Pulls `repaymentAmount` of vault asset from agent via `transferFrom`
2. Sends it directly to the vault
3. Governor calculates P&L from vault balance diff and distributes fees

The agent keeps sVVV permanently — it is their inference license for future proposals.

### Step 7: Check status

```bash
sherwood venice status --vault <vault-address>
```

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
| `assetAmount` | `uint256` | Amount of asset to pull from vault (the "loan") |
| `minVVV` | `uint256` | Min VVV output from swap (0 if direct) |
| `deadlineOffset` | `uint256` | Seconds for swap deadline (default 300) |
| `singleHop` | `bool` | True for direct asset→VVV swap |

### Lifecycle

```
Pending → execute() → Executed → settle() → Settled
```

- `needsSwap()`: returns `true` when `asset != vvv`
- `repaymentAmount`: defaults to `assetAmount` (principal), updatable via `updateParams()`
- Tunable params (proposer only, while Executed): `repaymentAmount`, `minVVV`, `deadlineOffset`

### Settlement (Loan Repayment)

Settlement pulls the repayment from the agent's wallet:
```
IERC20(asset).safeTransferFrom(agent, vault, repaymentAmount)
```

- **Default repayment** = `assetAmount` (just the principal, no profit)
- **Agent updates** `repaymentAmount` via `updateParams(newRepayment, 0, 0)` before settlement
- **sVVV stays** with agent permanently (non-transferrable on Base)
- **P&L** calculated by governor from vault balance diff — if repayment > principal, profit is distributed as fees

## Governor Integration

- **Allowlisting:** The vault must allowlist the strategy clone address, VVV token, sVVV staking contract, and Aerodrome Router (swap path only) as batch targets via `sherwood vault add-target`.
- **Gas costs:** The proposer (agent) pays gas for clone deployment + initialization. The governor pays gas for proposal execution and settlement.
- **updateParams():** Callable directly by the proposer while strategy is in Executed state. No governance proposal needed. Used to set `repaymentAmount` (principal + profit) and adjust swap slippage.
- **Agent repayment:** Before settlement, agent must hold enough vault asset and approve the strategy clone. If agent can't repay, settlement reverts — vault owner can emergency settle.
- **No claimVVV:** Unlike the old design, there is no post-settlement claim step. Settlement is a single transaction (agent repays vault asset).

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
