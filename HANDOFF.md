# Sherwood — Development Handoff

## What This Is

Agent-managed investment syndicates. Autonomous DeFi strategies with verifiable track records.

Monorepo: `https://github.com/imthatcarlos/sherwood`

```
contracts/   Foundry — Solidity smart contracts (deployed, tested)
cli/         TypeScript CLI for agents (viem, scaffolded)
app/         Next.js dashboard (scaffolded, not priority)
```

## What's Built

### Contracts (Foundry, Solidity 0.8.28, all tests passing)

**SyndicateVault.sol** — ERC-4626 vault with two-layer permission model
- LPs deposit USDC, get vault shares
- Agents registered by PKP address (Lit Protocol managed wallet) + operator EOA
- Syndicate-level caps: `maxPerTx`, `maxDailyTotal`, `maxBorrowRatio` (hard limits for ALL agents)
- Per-agent caps: individual `maxPerTx` + `dailyLimit` (must be ≤ syndicate caps)
- Daily spend tracking (resets each day) per-agent and syndicate-wide
- `ragequit()` — LP can exit at any time for pro-rata share
- UUPS upgradeable, Ownable, Pausable
- 16 passing tests

**BatchExecutor.sol** — Generic batched call executor
- `executeBatch(Call[])` — atomic execution of arbitrary contract calls
- `simulateBatch(Call[])` — dry-run returns per-call success/failure (call via `eth_call`)
- Target allowlist — only approved protocol addresses can be called (owner manages)
- `Call = { target: address, data: bytes, value: uint256 }`
- Not upgradeable (simple, stateless-ish). Owned by vault creator.
- 12 passing tests

**StrategyRegistry.sol** — On-chain registry of strategies (exists but not wired to the flow yet)

### CLI (TypeScript, partially scaffolded)

**strategies/levered-swap.ts** — First purpose-built strategy
- `buildEntryBatch(config, executorAddress, amountOutMinimum)` → `BatchCall[]`
  - approve USDC → mUSDC
  - mUSDC.mint (deposit collateral)
  - comptroller.enterMarkets
  - mUSDC.borrow
  - approve USDC → SwapRouter
  - SwapRouter.exactInputSingle
- `buildExitBatch(config, executorAddress, tokenBalance, amountOutMinimum, borrowBalance)` → `BatchCall[]`
  - approve target → SwapRouter
  - SwapRouter.exactInputSingle (sell)
  - approve USDC → mUSDC
  - mUSDC.repayBorrow
  - mUSDC.redeemUnderlying
- All ABIs defined inline, encoding via viem's `encodeFunctionData`

**lib/addresses.ts** — Verified Base mainnet addresses
- Tokens: USDC, WETH, cbETH, wstETH, cbBTC, DAI, AERO
- Moonwell: Comptroller + 7 mToken markets
- Uniswap V3 SwapRouter
- Multicall3

**lib/batch.ts** — BatchCall type + formatBatch() helper

## What Needs To Be Done

### 1. Wire CLI to Chain (HIGH PRIORITY)

The CLI can build batches but can't send them yet. Need:

**a) viem client setup (`cli/src/lib/client.ts`)**
- Create a viem `publicClient` (for reads) and `walletClient` (for writes)
- Chain: Base (`import { base } from "viem/chains"`)
- RPC: use env var `BASE_RPC_URL` (or default to public Base RPC)
- Private key: env var `PRIVATE_KEY` (this is the Lit PKP key or test EOA for now)
- Use `createPublicClient`, `createWalletClient` from viem

**b) BatchExecutor client (`cli/src/lib/executor.ts`)**
- Load BatchExecutor ABI from `contracts/out/BatchExecutor.sol/BatchExecutor.json`
- Functions needed:
  - `simulate(calls: BatchCall[])` — call `simulateBatch` via `publicClient.call` (eth_call, no gas)
  - `execute(calls: BatchCall[])` — call `executeBatch` via `walletClient.writeContract`
  - `addTarget(target: Address)` — owner adds to allowlist
  - `isAllowedTarget(target: Address)` → boolean
- Contract address from env var `BATCH_EXECUTOR_ADDRESS`

**c) Vault client (`cli/src/lib/vault.ts`)**
- Load SyndicateVault ABI from `contracts/out/SyndicateVault.sol/SyndicateVault.json`
- Functions needed:
  - `deposit(amount: bigint)` — LP deposits USDC
  - `ragequit()` — LP exits
  - `registerAgent(pkp, eoa, maxPerTx, dailyLimit)` — owner registers agent
  - `executeStrategy(strategyAddress, data, assetAmount)` — agent runs strategy
  - `getAgentConfig(pkp)` → config
  - `getSyndicateCaps()` → caps
- Contract address from env var `VAULT_ADDRESS`

### 2. Uniswap Quote Integration (HIGH PRIORITY)

The strategy needs `amountOutMinimum` for slippage protection. Currently a TODO.

**Option A: Uniswap Quoter contract (simpler)**
- Quoter V2 on Base: `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`
- Call `quoteExactInputSingle(tokenIn, tokenOut, fee, amountIn, sqrtPriceLimitX96)` via eth_call
- Apply slippage tolerance: `amountOutMinimum = quote * (10000 - slippageBps) / 10000`

**Option B: Uniswap SDK (more robust)**
- `@uniswap/v3-sdk` + `@uniswap/smart-order-router`
- Finds optimal route (single-hop or multi-hop)
- Returns quote with price impact
- More complex but handles edge cases (no direct pair, multiple hops)

Start with Option A. Upgrade to B if needed.

### 3. Deploy Contracts to Base Sepolia (MEDIUM PRIORITY)

Need a Foundry deploy script and actual deployment.

**`contracts/script/Deploy.s.sol`:**
```solidity
// Deploy SyndicateVault (via ERC1967Proxy)
// Deploy BatchExecutor
// Initialize vault with USDC as asset
// Add Moonwell + Uniswap targets to BatchExecutor allowlist
// Register a test agent
```

**Addresses needed:**
- Base Sepolia USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- Base Sepolia Moonwell Comptroller: need to verify (may not exist on testnet)
- Alternative: deploy to Base mainnet with small amounts (gas is cheap, ~$0.004/tx)

### 4. Messari Integration (MEDIUM PRIORITY)

The agent brain needs market data to decide when/what to trade.

**Messari API endpoints to integrate:**
- `POST /ai/v2/chat/completions` — ask "should I go long on WETH right now?"
- `GET /signal/v1/assets/{assetId}` — sentiment score, social buzz
- `GET /metrics/v2/assets/details?slugs=ethereum` — price, volume, market cap
- `GET /news/v1/news/feed` — breaking news that might move markets

**Auth:** Either `x-messari-api-key` header or x402 pay-per-request.
- x402 flow: send request → get 402 → parse payment requirements → sign with wallet → retry with `Payment-Signature` header
- For MVP: just use API key mode

**File: `cli/src/lib/messari.ts`**
- `getSignal(assetSlug: string)` → sentiment data
- `getMetrics(assetSlug: string)` → price/volume
- `askAI(question: string)` → synthesis response

**Messari skill references:**
- OpenClaw: `https://github.com/messari/skills` (installed at `~/.openclaw/skills/messari/`)
- Full API docs: `https://docs.messari.io`

### 5. Strategy CLI Command (MEDIUM PRIORITY)

Wire the strategy into the CLI so an agent (or human) can run it.

**`sherwood strategy run levered-swap`:**
```
1. Query Messari for market intel on target token
2. Display analysis summary
3. Build entry batch (buildEntryBatch)
4. Simulate batch (eth_call)
5. Display preview: calls, expected outcome, gas estimate
6. Confirm (or auto-execute if agent mode)
7. Execute batch (writeContract)
8. Enter monitor loop:
   - Poll position health every N seconds
   - Poll token price
   - If profit target hit → build + execute exit batch
   - If stop loss hit → build + execute exit batch
   - If health factor drops → partial unwind
```

### 6. Lit Protocol PKP Integration (LOWER PRIORITY)

Currently the CLI uses a raw private key. Need to integrate Lit PKP for production.

**What's needed:**
- `@lit-protocol/lit-node-client` SDK
- Create PKP for agent via Vincent dashboard or SDK
- Agent's EOA wallet is registered as auth method for the PKP
- PKP signs transactions instead of raw private key
- Lit Actions define per-agent policies (max amounts, allowed targets, etc.)

**Vincent docs:** `https://docs.heyvincent.ai/`
**Lit SDK:** `https://developer.litprotocol.com/sdk/introduction`

This can be deferred — use raw EOA key for hackathon demo, show Lit architecture in presentation.

## Key Architecture Decisions

- **Strategies are CLI code, not contracts.** New strategy = new `.ts` file. No new deployments.
- **BatchExecutor is protocol-agnostic.** It just does `target.call(data)` with an allowlist.
- **Two-layer permissions:** Vault caps (on-chain) + Lit policies (off-chain). Both must pass.
- **USDC on Base has 6 decimals.** All amounts use `parseUnits(amount, 6)`.
- **Agent wallets are Lit PKPs** (for production). EOA keys for development.
- **Vault is UUPS upgradeable** — can add LayerZero OVault support post-hackathon.

## Environment Variables

```env
BASE_RPC_URL=           # Base RPC (or use default public)
PRIVATE_KEY=            # Agent wallet (EOA for dev, PKP key for prod)
VAULT_ADDRESS=          # Deployed SyndicateVault proxy address
BATCH_EXECUTOR_ADDRESS= # Deployed BatchExecutor address
MESSARI_API_KEY=        # Messari API key (or use x402)
X402_PRIVATE_KEY=       # For x402 pay-per-request auth
```

## Dev Commands

```bash
# Contracts
cd contracts && forge build && forge test -vvv && forge fmt

# CLI
cd cli && npm install && npx tsc --noEmit
```

## File Map

```
contracts/
├── src/
│   ├── SyndicateVault.sol      ← ERC-4626 vault with agent permissions
│   ├── BatchExecutor.sol       ← Generic batch call executor
│   ├── StrategyRegistry.sol    ← On-chain strategy registry (not wired yet)
│   └── interfaces/
│       ├── ISyndicateVault.sol
│       └── IStrategyRegistry.sol
├── test/
│   ├── SyndicateVault.t.sol    ← 16 tests
│   ├── BatchExecutor.t.sol     ← 12 tests
│   └── mocks/
│       ├── ERC20Mock.sol       ← 6-decimal USDC mock
│       ├── MockMToken.sol
│       ├── MockComptroller.sol
│       └── MockSwapRouter.sol
└── foundry.toml

cli/
├── src/
│   ├── index.ts                ← Commander CLI entry point
│   ├── types.ts                ← Provider interfaces
│   ├── strategies/
│   │   ├── levered-swap.ts     ← First strategy (entry + exit batches)
│   │   └── README.md
│   ├── lib/
│   │   ├── addresses.ts        ← Verified Base addresses
│   │   └── batch.ts            ← BatchCall type + helpers
│   └── providers/
│       ├── moonwell.ts         ← Scaffolded (needs implementation)
│       └── uniswap.ts          ← Scaffolded (needs implementation)
├── package.json
└── tsconfig.json
```
