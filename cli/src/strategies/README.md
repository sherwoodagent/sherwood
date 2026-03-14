# Strategies

Purpose-built DeFi strategies that agents execute via the on-chain BatchExecutor.
Each strategy is a TypeScript module that constructs batched contract calls.

## How Strategies Work

```
Agent Brain (LLM + Messari data)
        ↓
Strategy Module (this directory)
  → Builds BatchCall[] from config
  → CLI simulates via eth_call
  → CLI shows preview to agent
        ↓
BatchExecutor Contract (on-chain)
  → Executes calls atomically
  → Target allowlist enforced
```

## Available Strategies

### Levered Swap (`levered-swap.ts`)

Leveraged long position using Moonwell + Uniswap on Base.

**Flow:**
1. Deposit USDC collateral into Moonwell
2. Borrow USDC against collateral
3. Swap borrowed USDC into target token on Uniswap
4. Monitor position (health factor, P&L, market sentiment)
5. Unwind: sell token → repay → withdraw

**Market Research:**
Uses [Messari API](https://docs.messari.io) for market intelligence:
- Signal API for sentiment + trending tokens
- Metrics API for price/volume data
- AI service for synthesis and research
- Auth: x402 (pay-per-request with USDC on Base) or API key

When the agent needs market research on a crypto project, it queries Messari.
See the [Messari OpenClaw skill](https://github.com/messari/skills) or
[Messari Claude skill](https://github.com/messari/skills/tree/master/claude).

**Required Allowlist Targets:**
- `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — USDC
- `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22` — Moonwell mUSDC
- `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C` — Moonwell Comptroller
- `0x2626664c2603336E57B271c5C0b26F421741e481` — Uniswap V3 SwapRouter
- Target token contract address

## Adding New Strategies

1. Create a new `.ts` file in this directory
2. Export `buildEntryBatch()` and `buildExitBatch()` functions
3. Define the ABIs for protocols your strategy touches
4. Add required allowlist targets to the README
5. The on-chain contracts don't change — strategies are pure CLI code
