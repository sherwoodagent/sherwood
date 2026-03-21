---
name: levered-swap
description: Executes Sherwood's levered swap strategy on Base — deposits WETH as collateral on Moonwell, borrows USDC, and swaps into a target token via Uniswap V3. Guides step-by-step through token research (DexScreener), risk assessment, parameter selection, simulation, and on-chain execution. Triggers on leveraged trading, collateral + borrow strategies, levered swaps, or entering positions.
allowed-tools: Read, Glob, Grep, Bash(npx:*), Bash(cd:*), Bash(curl:*), Bash(jq:*), WebFetch, WebSearch, AskUserQuestion
model: sonnet
license: MIT
metadata:
  author: sherwood
  version: '0.1.0'
---

# Levered Swap Strategy

Interactive assistant for executing the Sherwood levered swap strategy on Base.

> **Strategy**: Deposit WETH as collateral on Moonwell, borrow USDC, swap USDC into a target token via Uniswap V3. The vault acts as an authorization layer only (no vault capital at risk).

> **Runtime Compatibility:** This skill uses `AskUserQuestion` for interactive prompts. If `AskUserQuestion` is not available, collect parameters through natural language conversation instead.

## Prerequisites

Before running this skill, ensure:
- `cli/.env` is configured with `BASE_RPC_URL`, `PRIVATE_KEY`, `VAULT_ADDRESS`, `BATCH_EXECUTOR_ADDRESS`
- The agent wallet has WETH available (the agent provides its own collateral)
- The agent is registered on the vault (`sherwood vault register-agent`)
- WETH has been sent to the BatchExecutor address before execution

## Workflow

### Step 1: Research Target Tokens

Help the user find a token to buy with the borrowed USDC. Use a combination of web search and DexScreener to identify candidates.

#### Option A: User Already Has a Token Address

If the user provides a token address, skip to Step 2.

#### Option B: Search by Keyword

Use DexScreener to find tokens on Base traded on Uniswap:

```bash
curl -s "https://api.dexscreener.com/latest/dex/search?q=<keyword>" | \
  jq '[.pairs[] | select(.chainId == "base" and .dexId == "uniswap")] |
    sort_by(-.volume.h24) | .[0:5] | map({
      token: .baseToken.symbol,
      name: .baseToken.name,
      address: .baseToken.address,
      price: .priceUsd,
      volume24h: .volume.h24,
      liquidity: .liquidity.usd,
      priceChange24h: .priceChange.h24
    })'
```

#### Option C: Web Search for Trending Tokens

For broad discovery, use web search:

```text
"trending tokens Base chain 2026" OR "top performing Base tokens"
```

Then verify found tokens on DexScreener:

```bash
curl -s "https://api.dexscreener.com/token-pairs/v1/base/<address>" | \
  jq '[.[] | select(.dexId == "uniswap")][0] | {
    name: .baseToken.name,
    symbol: .baseToken.symbol,
    price: .priceUsd,
    liquidity: .liquidity.usd,
    volume24h: .volume.h24
  }'
```

#### Present Options

After gathering token data, present options using AskUserQuestion:

```json
{
  "questions": [
    {
      "question": "Which token do you want to buy with the borrowed USDC?",
      "header": "Target",
      "options": [
        { "label": "TOKEN1 ($X.XX)", "description": "$YM liquidity, $ZM 24h volume" },
        { "label": "TOKEN2 ($X.XX)", "description": "$YM liquidity, $ZM 24h volume" },
        { "label": "TOKEN3 ($X.XX)", "description": "$YM liquidity, $ZM 24h volume" }
      ],
      "multiSelect": false
    }
  ]
}
```

#### Risk Assessment

Evaluate tokens before recommending:

| Metric     | Low Risk | Medium Risk | High Risk |
|------------|----------|-------------|-----------|
| Pool TVL   | >$1M     | $100k-$1M  | <$100k    |
| 24h Volume | >$500k   | $50k-$500k | <$50k     |
| Age        | >30 days | 7-30 days   | <7 days   |

**Always warn about high-risk tokens** and require explicit confirmation via AskUserQuestion before proceeding.

---

### Step 2: Confirm Token Address

Once the user picks a token, confirm the contract address. The address must be a valid ERC20 on Base (match `^0x[a-fA-F0-9]{40}$`).

Display the selected token info:

```markdown
## Selected Token

| Field     | Value                                        |
|-----------|----------------------------------------------|
| Token     | SYMBOL (Name)                                |
| Address   | 0x...                                        |
| Price     | $X.XX                                        |
| Liquidity | $X.XM                                        |
| Chain     | Base                                         |
```

---

### Step 3: Configure Strategy Parameters

Ask the user for strategy parameters using AskUserQuestion:

**Collateral amount (WETH):**

```json
{
  "questions": [
    {
      "question": "How much WETH do you want to deposit as collateral?",
      "header": "Collateral",
      "options": [
        { "label": "0.1 WETH", "description": "~$320 collateral" },
        { "label": "0.5 WETH", "description": "~$1,600 collateral" },
        { "label": "1.0 WETH", "description": "~$3,200 collateral" }
      ],
      "multiSelect": false
    }
  ]
}
```

**Borrow amount (USDC):**

```json
{
  "questions": [
    {
      "question": "How much USDC do you want to borrow against your collateral?",
      "header": "Borrow",
      "options": [
        { "label": "500 USDC", "description": "Conservative leverage" },
        { "label": "1000 USDC", "description": "Moderate leverage" },
        { "label": "2000 USDC", "description": "Higher leverage — check vault caps" }
      ],
      "multiSelect": false
    }
  ]
}
```

**Fee tier:**

```json
{
  "questions": [
    {
      "question": "Which Uniswap fee tier? (Lower fees = tighter spreads for liquid pairs)",
      "header": "Fee",
      "options": [
        { "label": "0.05% (500 bps)", "description": "Best for stablecoin or high-liquidity pairs (Recommended)" },
        { "label": "0.30% (3000 bps)", "description": "Standard tier for most pairs" },
        { "label": "1.00% (10000 bps)", "description": "For exotic or low-liquidity pairs" }
      ],
      "multiSelect": false
    }
  ]
}
```

**Slippage:**

```json
{
  "questions": [
    {
      "question": "Slippage tolerance?",
      "header": "Slippage",
      "options": [
        { "label": "0.5% (50 bps)", "description": "Tight — may fail on volatile tokens" },
        { "label": "1.0% (100 bps)", "description": "Standard (Recommended)" },
        { "label": "2.0% (200 bps)", "description": "Loose — for volatile tokens" }
      ],
      "multiSelect": false
    }
  ]
}
```

---

### Step 4: Display Strategy Summary

Before running, display a full summary for confirmation:

```markdown
## Levered Swap Strategy

| Parameter    | Value                        |
|--------------|------------------------------|
| Collateral   | X.X WETH (agent-provided)    |
| Borrow       | X USDC (from Moonwell)       |
| Buy          | TOKEN (0x...)                |
| Fee Tier     | X.XX%                        |
| Slippage     | X.XX%                        |
| Vault        | 0x...                        |

### Batch Calls (6)
1. Approve mWETH to spend WETH
2. Deposit WETH into Moonwell (mint mWETH)
3. Enter WETH market on Moonwell
4. Borrow USDC from Moonwell
5. Approve SwapRouter to spend USDC
6. Swap USDC -> TARGET via Uniswap V3

### Important
- Agent must have sent WETH to the BatchExecutor before executing
- The vault is authorization-only (assetAmount = 0)
- Simulation runs first to check vault caps and batch validity
```

Ask for confirmation:

```json
{
  "questions": [
    {
      "question": "Ready to simulate this strategy?",
      "header": "Confirm",
      "options": [
        { "label": "Simulate", "description": "Run simulation only (no on-chain state changes)" },
        { "label": "Modify", "description": "Change parameters before running" }
      ],
      "multiSelect": false
    }
  ]
}
```

---

### Step 5: Simulate

Run the strategy in simulation mode (no `--execute` flag):

```bash
cd cli && npx tsx src/index.ts strategy run \
  --vault <VAULT_ADDRESS> \
  --collateral <WETH_AMOUNT> \
  --borrow <USDC_AMOUNT> \
  --token <TOKEN_ADDRESS> \
  --fee <FEE_TIER> \
  --slippage <SLIPPAGE_BPS>
```

This will:
1. Fetch a live Uniswap quote (USDC -> target token)
2. Build the 6-call entry batch
3. Simulate via `vault.executeStrategy` (eth_call)
4. Display results without committing state

**If simulation fails**, display the error and suggest fixes (e.g., insufficient WETH, vault caps exceeded, pool doesn't exist for the fee tier).

**If simulation succeeds**, ask whether to execute:

```json
{
  "questions": [
    {
      "question": "Simulation passed. Execute on-chain?",
      "header": "Execute",
      "options": [
        { "label": "Execute", "description": "Submit the transaction on Base mainnet" },
        { "label": "Cancel", "description": "Stop here, no on-chain changes" }
      ],
      "multiSelect": false
    }
  ]
}
```

---

### Step 6: Execute

If the user confirms, run with `--execute`:

```bash
cd cli && npx tsx src/index.ts strategy run \
  --vault <VAULT_ADDRESS> \
  --collateral <WETH_AMOUNT> \
  --borrow <USDC_AMOUNT> \
  --token <TOKEN_ADDRESS> \
  --fee <FEE_TIER> \
  --slippage <SLIPPAGE_BPS> \
  --execute
```

Display the transaction hash and BaseScan link on success.

---

## Error Handling

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| `VAULT_ADDRESS env var is required` | Missing .env config | Set `VAULT_ADDRESS` in `cli/.env` |
| `BATCH_EXECUTOR_ADDRESS env var is required` | Missing .env config | Set `BATCH_EXECUTOR_ADDRESS` in `cli/.env` |
| `Could not read decimals` | Invalid token address or not ERC20 | Verify the token address on BaseScan |
| `Simulation failed` | Vault caps exceeded, or batch reverts | Check agent limits, borrow ratio, daily spend |
| `Execution failed` | On-chain revert | Check WETH balance at executor, gas, caps |

## Key Addresses (Base)

| Contract | Address |
|----------|---------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| WETH | `0x4200000000000000000000000000000000000006` |
| Moonwell Comptroller | `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C` |
| Uniswap SwapRouter | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Uniswap Quoter V2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |

## Further Reading

- [DeFi Protocol Integrations](https://docs.sherwood.sh/reference/integrations/defi-protocols) — Moonwell and Uniswap integration details
- [CLI Commands](https://docs.sherwood.sh/cli/commands) — Full command reference
