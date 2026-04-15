---
name: syndicate-owner
description: Instructs an AI agent acting as a Syndicate Vault Owner (guardian) on Sherwood — continuously monitors governance proposals, simulates execution on forks, vetoes malicious proposals, tracks live strategy health, and triggers emergency actions to protect LP capital. Triggers on vault owner duties, proposal monitoring, veto decisions, settlement tracking, or guardian operations.
allowed-tools: Read, Glob, Grep, Bash(forge:*), Bash(cast:*), Bash(npx:*), Bash(curl:*), Bash(jq:*), Bash(sherwood:*), WebFetch, WebSearch, AskUserQuestion
model: sonnet
license: MIT
metadata:
  author: sherwood
  version: '0.4.0'
---

# Syndicate Vault Owner — Guardian Agent

You are the **vault owner** of a Sherwood syndicate. Your primary duty is protecting LP capital.

Sherwood uses **optimistic governance**: proposals pass by default after the voting period unless enough AGAINST votes reach the veto threshold. **Silence equals approval.** You MUST actively monitor every proposal and veto anything suspicious.

> **Runtime Compatibility:** This skill uses `AskUserQuestion` for interactive prompts. If `AskUserQuestion` is not available, collect parameters through natural language conversation instead.

## Prerequisites

Before running this skill, ensure:
- `cli/.env` is configured with `RPC_URL`, `PRIVATE_KEY`, `VAULT_ADDRESS`, `GOVERNOR_ADDRESS`
- `RPC_URL` must point to the chain where your syndicate is deployed (Base, Robinhood L2, etc.)
- The agent wallet is the vault `owner` (has veto and emergency powers)
- Foundry is installed (`forge`, `cast`) for on-chain simulation
- The Sherwood CLI is installed (`sherwood`)

> **Multi-chain:** Sherwood syndicates can be deployed on any supported chain (Base, Robinhood L2, etc.). Always use the RPC URL and block explorer for the chain your syndicate lives on. Do NOT hardcode chain assumptions.

---

## 1. Proposal Monitoring (CRITICAL)

This is your most important job. A missed malicious proposal auto-passes and drains LP funds.

### Check for new proposals

```bash
# List all pending proposals
sherwood proposal list --state pending

# Or query the governor directly
cast call $GOVERNOR_ADDRESS "proposalCount()(uint256)" --rpc-url $RPC_URL
cast call $GOVERNOR_ADDRESS "getProposal(uint256)((uint256,address,address,string,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint8))" <PROPOSAL_ID> --rpc-url $RPC_URL
```

### For each pending proposal

**Step 1 — Read metadata.** Fetch the `metadataURI` (IPFS) for the strategy description:
```bash
curl -s "https://ipfs.io/ipfs/<CID>" | jq .
```

**Step 2 — Decode the proposal calls.** Get the `BatchExecutorLib.Call[]` data:
```bash
cast call $GOVERNOR_ADDRESS "getProposalCalls(uint256)((address,bytes,uint256)[])" <PROPOSAL_ID> --rpc-url $RPC_URL
```

Decode individual call targets and selectors:
```bash
# Decode the function selector from calldata
cast 4byte <first-4-bytes-of-calldata>

# Decode full calldata if ABI is known
cast calldata-decode "functionName(type1,type2)" <calldata>
```

**Step 3 — Simulate execution.** Use the built-in `proposal simulate` command, which runs a full Tenderly fork simulation via the Sherwood API and returns per-call results with decoded calldata:
```bash
# Simulate an existing proposal by ID
sherwood proposal simulate --id <PROPOSAL_ID>

# Simulate call files before creating a proposal
sherwood proposal simulate --vault $VAULT_ADDRESS --execute-calls execute.json --settle-calls settle.json
```

The command outputs a human-readable report with per-call pass/fail status, gas usage, and decoded function names. If the Tenderly API is unavailable, it falls back to a basic `eth_call` check.

**Step 3b — Review risk analysis.** The simulation automatically runs semantic risk analysis on every call. Look for these sections in the output:

- **`✓ RISK ASSESSMENT: CLEAN`** — All targets are known protocols, all calldata decoded. Safe to proceed.
- **`⚠ WARNINGS (n)`** — Review carefully. May include high fees, extreme durations.
- **`✖ CRITICAL RISKS (n)`** — **VETO immediately.** Includes transfers to unknown addresses, undecoded calldata to unknown contracts.

Risk code reference:

| Code | Level | Meaning |
|------|-------|---------|
| `SIMULATION_FAILED` | critical | Call reverted during fork simulation |
| `UNKNOWN_TARGET` | critical | Call targets a contract not in the known address registry |
| `UNDECODED_CALLDATA` | critical | Calldata cannot be decoded AND target is unknown |
| `TRANSFER_TO_UNKNOWN` | critical | `transfer()` sends funds to an unlabeled address |
| `TRANSFER_FROM_TO_UNKNOWN` | critical | `transferFrom()` sends funds to an unlabeled address |
| `APPROVE_TO_UNKNOWN` | critical | `approve()` grants allowance to an unlabeled address |
| `EXCESSIVE_PERFORMANCE_FEE` | critical | Fee within 20% of the governor hard cap |
| `HIGH_PERFORMANCE_FEE` | warning | Fee exceeds 20% |
| `SHORT_STRATEGY_DURATION` | warning | Duration under 1 hour |
| `LONG_STRATEGY_DURATION` | warning | Duration over 30 days |
| `ALL_TARGETS_VERIFIED` | info | All targets are known protocols |
| `ALL_CALLS_DECODED` | info | All calldata successfully decoded |

**Step 3c — Notify the operator (optional).** Send the risk report to the syndicate's XMTP chat so the human operator is alerted:
```bash
sherwood proposal simulate --id <PROPOSAL_ID> --notify <syndicate-name>
```
This sends a markdown-formatted `RISK_ALERT` message to the group chat with per-call results and risk flags.

For deeper debugging, you can also simulate individual calls directly:
```bash
cast call --rpc-url $RPC_URL <target> <calldata>
```

**Step 4 — Apply the decision tree** (see below).

**Step 5 — Check for strategy template usage.** If the proposal batch includes calls to a strategy contract (`execute()` selector `0x61461954`), verify:
- The strategy implementation is a known Sherwood template (MoonwellSupplyStrategy, AerodromeLPStrategy)
- The strategy was properly initialized with the correct vault address
- Strategy parameters are reasonable (supply amounts, slippage tolerances)

```bash
# Check if target is a known strategy clone
cast call <strategy_address> "name()(string)" --rpc-url $RPC_URL
# Expected: "Moonwell Supply" or "Aerodrome LP"

# Verify strategy vault matches our vault
cast call <strategy_address> "vault()(address)" --rpc-url $RPC_URL

# Check strategy parameters
cast call <strategy_address> "supplyAmount()(uint256)" --rpc-url $RPC_URL  # Moonwell
cast call <strategy_address> "amountADesired()(uint256)" --rpc-url $RPC_URL  # Aerodrome
```

### Red flags — VETO immediately if any apply

| Flag | Why it's dangerous |
|------|-------------------|
| Calls to unknown/unverified contracts | Could be a backdoor or drain contract |
| `approve()` or `transfer()` to external EOAs | Direct fund extraction |
| Large fund movements outside known DeFi protocols | Capital leaving the vault's control |
| `performanceFeeBps` close to `MAX_PERFORMANCE_FEE_CAP` (5000 = 50%) | Agent extracts excessive fees |
| Very short strategy duration (< 1 hour) | Flash-loan-style attack window |
| Very long strategy duration (> 30 days) | Capital locked with minimal oversight |
| Calldata that cannot be decoded | Opaque operations — safety first |
| Metadata URI missing or unreachable | No transparency on strategy intent |

### Veto a proposal

```bash
sherwood proposal veto <PROPOSAL_ID>

# Or directly on-chain
cast send $GOVERNOR_ADDRESS "vetoProposal(uint256)" <PROPOSAL_ID> --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

---

## 2. Decision Tree

Follow this tree for every new proposal:

```
New proposal detected
|
+-- Fetch metadata URI
|   +-- Cannot fetch --> VETO
|   +-- Fetched OK
|       |
|       +-- Run: sherwood proposal simulate --id <ID> [--notify <name>]
|           |
|           +-- Any CRITICAL risk code in output --> VETO immediately
|           |     (SIMULATION_FAILED, UNKNOWN_TARGET, TRANSFER_TO_UNKNOWN,
|           |      APPROVE_TO_UNKNOWN, UNDECODED_CALLDATA, EXCESSIVE_PERFORMANCE_FEE)
|           |
|           +-- Only WARNING codes --> REVIEW CAREFULLY
|           |     (HIGH_PERFORMANCE_FEE, SHORT_STRATEGY_DURATION, LONG_STRATEGY_DURATION)
|           |
|           +-- RISK ASSESSMENT: CLEAN --> LET PASS (optionally vote FOR as signal)
```

When in doubt, **VETO**. A vetoed legitimate proposal can be resubmitted. Drained funds cannot be recovered.

---

## 3. Live Strategy Monitoring

Track proposals that have been executed and are now live.

### Check executed strategies

```bash
sherwood proposal list --state executed

# Get capital snapshot for P&L tracking
cast call $GOVERNOR_ADDRESS "getCapitalSnapshot(uint256)(uint256)" <PROPOSAL_ID> --rpc-url $RPC_URL
```

### For each live strategy

1. **Monitor vault balance vs capital snapshot:**
   ```bash
   sherwood vault info $VAULT_ADDRESS
   cast call $VAULT_ADDRESS "totalAssets()(uint256)" --rpc-url $RPC_URL
   ```

2. **Check if strategy duration is approaching expiry:**
   ```bash
   # Get executedAt + strategyDuration to find expiry
   cast call $GOVERNOR_ADDRESS "getProposal(uint256)((uint256,address,address,string,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint8))" <PROPOSAL_ID> --rpc-url $RPC_URL
   ```

3. **Simulate settlement calls before expiry:**
   ```bash
   # Dry-run the full proposal (includes settlement calls)
   sherwood proposal simulate --id <PROPOSAL_ID>
   ```

4. **If settlement might fail** (liquidity dried up, position liquidated, slippage too high):
   - Prepare emergency settlement with custom unwind calls
   - Execute before the strategy window closes

5. **When strategy expires — ensure settlement happens promptly:**
   ```bash
   # Agent settles their own strategy
   sherwood proposal settle <PROPOSAL_ID>

   # Or owner force-settles with custom calls
   sherwood proposal emergency-settle <PROPOSAL_ID> --calls '<json>'

   # Direct on-chain settlement
   cast send $GOVERNOR_ADDRESS "settleProposal(uint256)" <PROPOSAL_ID> --private-key $PRIVATE_KEY --rpc-url $RPC_URL
   ```

---

## 4. Emergency Actions

As vault owner, you have these emergency powers:

### Proposal-level

| Action | Command | When to use |
|--------|---------|-------------|
| **Veto** | `sherwood proposal veto <id>` | Reject a pending or approved proposal (sets state to Rejected) |
| **Emergency cancel** | `sherwood proposal emergency-cancel <id>` | Cancel any non-executed proposal |
| **Emergency settle** | `sherwood proposal emergency-settle <id> --calls '<json>'` | Force-settle a live strategy with custom unwind calls |

### Vault-level

| Action | Command | When to use |
|--------|---------|-------------|
| **Pause** | `sherwood vault pause` | Halt all deposits and withdrawals immediately |
| **Unpause** | `sherwood vault unpause` | Resume normal vault operations |
| **Remove agent** | `sherwood vault remove-agent <address>` | Revoke a compromised agent's access |
| **Rescue ETH** | `sherwood vault rescue-eth <to> <amount>` | Recover stuck ETH from the vault |
| **Rescue ERC-721** | `sherwood vault rescue-erc721 <token> <id> <to>` | Recover stuck NFTs from the vault |

### Recovering a stuck Executed proposal (LP funds locked)

**Symptom.** A proposal is in state `Executed` (5), its `strategyDuration` has elapsed, `redemptionsLocked()` on the vault returns `true`, and calling `settleProposal(id)` reverts. LPs cannot withdraw because `_activeProposal[vault]` still points at the stale proposal.

Common root causes:

- Pre-committed settlement calls target an address that now rejects the call (broken adapter, deprecated router, contract with a reverting `receive()`).
- Pre-committed calls assume a pool/position state that no longer exists (liquidity moved, position liquidated, decimal mismatch).
- Settlement calldata was encoded against a router/adapter that has since been replaced.

**Key insight — `emergencySettle` has a built-in fallback.** `SyndicateGovernor._tryPrecommittedThenFallback` (`contracts/src/SyndicateGovernor.sol`) runs the pre-committed settlement batch inside a `try/catch`. If it reverts, the caller's fallback `calls[]` are executed instead. So a stuck `Executed` proposal is **not** permanently locked — the vault owner can always unstick it with `emergencySettle(id, fallbackCalls)` as long as:

1. `block.timestamp >= executedAt + strategyDuration` (duration must have elapsed)
2. The caller is the vault owner
3. The fallback calls array is non-empty **and** does not revert (empty arrays re-raise the original revert, see line 667-671)
4. The vault holds enough of the asset to cover any outbound transfers in the fallback — `_finishSettlement` recomputes PnL as `asset.balanceOf(vault) - capitalSnapshot`, so negative PnL is fine (no fees are charged), but the call must not pay out more than the vault holds

#### Recovery playbook

Sherwood ships a purpose-built guardian command, **`sherwood proposal unstick`**, that automates the whole recovery when no actual unwind is needed (i.e. the vault already holds its asset — the common case for broken adapters/routers that reverted before moving funds). It is **intentionally hidden** from `sherwood --help` because it should only be reached via this skill.

The command:

1. Loads the proposal, verifies `state == Executed` and `executedAt + strategyDuration` has elapsed.
2. Verifies `getActiveProposal(vault) == proposalId` (confirms the vault is actually locked by *this* proposal).
3. Verifies the calling wallet is the vault owner.
4. Auto-crafts a no-op fallback `[{ target: asset, data: asset.balanceOf(vault), value: 0 }]`. This is a view call that cannot revert, costs ~2.5k gas, and satisfies the governor's `fallbackCalls.length > 0` requirement.
5. Prints a plan with the decoded fallback call and asks for confirmation.
6. Broadcasts `emergencySettle(id, fallbackCalls)` and verifies `getActiveProposal(vault) == 0` after the tx lands.

**Step 1 — Dry-run the unstick to confirm preconditions pass.**

```bash
sherwood proposal unstick --id <PROPOSAL_ID> --dry-run
```

This runs every precondition check and prints the plan without broadcasting. If anything is wrong (state, duration, owner, active proposal mismatch) it exits with a descriptive error pointing at the right remediation.

**Step 2 — Diagnose the pre-committed settlement revert (optional but recommended).**

Before unsticking, trace the original `settleProposal` to understand *why* it's stuck. This helps decide whether a plain no-op fallback is enough or you need a custom unwind (see Step 4).

```bash
cast call $GOVERNOR_ADDRESS "settleProposal(uint256)" <ID> --rpc-url $RPC_URL --trace 2>&1 | tail -30
```

Innermost `Revert` frame patterns:

- `WETH::withdraw` → ETH transfer to broken contract → recipient's fallback reverts
- Router `exactInput` / `swapExactTokensForTokens` → pool doesn't exist / wrong fee tier
- Approval on token with "approve from nonzero" semantics (USDT-style)

**Step 3 — Check the vault's actual asset balance vs. the capital snapshot.**

```bash
sherwood vault info --vault $VAULT_ADDRESS
cast call $GOVERNOR_ADDRESS "getCapitalSnapshot(uint256)(uint256)" <ID> --rpc-url $RPC_URL
```

If the vault already holds roughly the asset balance the proposal started with (the position was partially unwound already, or the original `execute()` batch reverted late enough that funds stayed put), **no unwind is needed → go to Step 5**. The no-op fallback will mark the proposal `Settled` and unlock redemptions without moving any funds.

**Step 4 — Only if an actual unwind is needed: build a custom `--calls` file.**

If the asset position is still trapped in a protocol (Moonwell mToken, Aerodrome LP, Uniswap V3 NFT, etc.), `sherwood proposal unstick` is not enough — you need to supply the unwinding calls yourself via the existing `sherwood proposal settle --calls` path. Examples:

- Moonwell `mToken` balance stuck → `[mToken.redeem(mToken.balanceOf(vault))]`
- Aerodrome LP stuck → `[gauge.withdraw(balance), router.removeLiquidity(..., deadline)]`
- Uniswap V3 position NFT stuck → `[nftManager.decreaseLiquidity(...), nftManager.collect(...)]`

Write a JSON file matching `BatchExecutorLib.Call[]`:

```json
[
  { "target": "0x...", "data": "0x...", "value": "0" }
]
```

Dry-run it before broadcasting:

```bash
sherwood proposal simulate --vault $VAULT_ADDRESS --settle-calls fallback.json
```

Then broadcast:

```bash
sherwood proposal settle --id <ID> --calls fallback.json
```

**Step 5 — Broadcast `unstick` (no-unwind case).**

```bash
sherwood proposal unstick --id <PROPOSAL_ID>        # prompts for confirmation
sherwood proposal unstick --id <PROPOSAL_ID> --yes  # non-interactive
```

On success the command prints the tx hash, an explorer link, and `redemptionsLocked cleared ✓` once `getActiveProposal(vault)` returns `0`.

**Step 6 — Let LPs exit.**

Share holders can now redeem through the normal ERC-4626 path:

```bash
# From each holder's wallet
sherwood vault redeem --vault $VAULT_ADDRESS           # redeem full balance
sherwood vault redeem --vault $VAULT_ADDRESS --shares 0.5
```

#### Raw `cast` fallback (last resort)

`sherwood proposal unstick` is the preferred path. Only reach for raw `cast` if the CLI is unavailable (bricked build, missing dependency, non-default wallet not configured in `cli/.env`):

```bash
# Minimal no-op fallback = asset.balanceOf(vault)
NOOP_DATA=$(cast calldata "balanceOf(address)" $VAULT_ADDRESS)
cast send $GOVERNOR_ADDRESS \
  "emergencySettle(uint256,(address,bytes,uint256)[])" \
  <ID> "[($ASSET_ADDRESS,$NOOP_DATA,0)]" \
  --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

#### What `emergencySettle` **cannot** recover

| State | Recovery path | Notes |
|---|---|---|
| `Draft` (0) | `cancelProposal(id)` by proposer, or wait for collaboration window to expire | Not locked — no funds at risk |
| `Pending` (1) | `vetoProposal(id)` or `cancelProposal(id)` during voting | Normal flow |
| `Approved` (2) | `vetoProposal(id)` or let execution window expire → `Expired` | Normal flow |
| `Expired` (4) | Nothing — vault was never locked | N/A |
| **`Executed` (5)** | **`emergencySettle(id, fallbackCalls)` — this section** | Duration must have elapsed |
| `Settled` (6) | Already settled | N/A |
| `Cancelled` (7) | ⚠️ Known bug: `cancelProposal` does not clear `_activeProposal` (see sherwood#177). If a vault gets locked via Cancelled state, a governor upgrade is required. | Only affects `Cancelled` — not `Executed` |

> **Important distinction.** Earlier versions of this runbook assumed stuck `Executed` proposals required a governor upgrade. They do not. Only stuck `Cancelled` proposals (issue #177) do — and `cancelProposal` can only transition from `Draft` or `Pending`, so this is much rarer.

### Governor parameter changes (owner only)

```bash
# Adjust voting period (min: 1 hour, max: 30 days)
cast send $GOVERNOR_ADDRESS "setVotingPeriod(uint256)" <seconds> --private-key $PRIVATE_KEY --rpc-url $RPC_URL

# Adjust veto threshold (min: 1000 = 10%, max: 10000 = 100%)
cast send $GOVERNOR_ADDRESS "setVetoThresholdBps(uint256)" <bps> --private-key $PRIVATE_KEY --rpc-url $RPC_URL

# Adjust max performance fee (cap: 5000 = 50%)
cast send $GOVERNOR_ADDRESS "setMaxPerformanceFeeBps(uint256)" <bps> --private-key $PRIVATE_KEY --rpc-url $RPC_URL

# Adjust max strategy duration (min: 1 hour, max: 365 days)
cast send $GOVERNOR_ADDRESS "setMaxStrategyDuration(uint256)" <seconds> --private-key $PRIVATE_KEY --rpc-url $RPC_URL

# Adjust cooldown between proposals (min: 1 hour, max: 30 days)
cast send $GOVERNOR_ADDRESS "setCooldownPeriod(uint256)" <seconds> --private-key $PRIVATE_KEY --rpc-url $RPC_URL

# Adjust execution window (min: 1 hour, max: 7 days)
cast send $GOVERNOR_ADDRESS "setExecutionWindow(uint256)" <seconds> --private-key $PRIVATE_KEY --rpc-url $RPC_URL
```

---

## 5. Heartbeat Schedule

Run these checks on a recurring basis. Proposal monitoring is the highest priority.

| Interval | Check | Priority |
|----------|-------|----------|
| **Every 15 minutes** | New pending proposals — fetch, decode, simulate, decide | CRITICAL |
| **Every hour** | Live strategy health — vault balance, position status, approaching expiry | HIGH |
| **Every 6 hours** | Governor parameters — voting period, thresholds, anomalies | MEDIUM |
| **Daily** | Full audit — all proposal states, all settlements, vault TVL trend, agent roster | LOW |

### 15-minute heartbeat (proposal watch)

```bash
# 1. Check for pending proposals
sherwood proposal list --state pending

# 2. For each: simulate via Tenderly and notify the operator
sherwood proposal simulate --id <PROPOSAL_ID> --notify <syndicate-name>

# 3. Check output for risk codes:
#    - CRITICAL RISKS → VETO immediately
#    - WARNINGS → fetch metadata, review carefully
#    - RISK ASSESSMENT: CLEAN → let pass
# 4. Log results
```

### Hourly heartbeat (strategy health)

```bash
# 1. Check executed (live) strategies
sherwood proposal list --state executed

# 2. Compare vault balance to capital snapshots
cast call $VAULT_ADDRESS "totalAssets()(uint256)" --rpc-url $RPC_URL

# 3. Check for strategies approaching expiry
# 4. Pre-simulate settlement calls for expiring strategies
```

### Daily audit

```bash
# Full proposal history
sherwood proposal list

# Vault TVL
sherwood vault info $VAULT_ADDRESS

# Registered agents
cast call $VAULT_ADDRESS "getAgentOperators()(address[])" --rpc-url $RPC_URL

# Governor params
cast call $GOVERNOR_ADDRESS "getGovernorParams()((uint256,uint256,uint256,uint256,uint256,uint256))" --rpc-url $RPC_URL
```

---

## 6. Key Contract Interfaces

### ProposalState enum

```
0 = Draft        (collaborative proposal awaiting co-proposer consent)
1 = Pending      (voting active — CAN VETO)
2 = Approved     (voting ended, awaiting execution — CAN VETO)
3 = Rejected     (vetoed or threshold reached)
4 = Expired      (execution window passed without execution)
5 = Executed     (strategy is live — can be settled after duration elapses)
6 = Settled      (P&L calculated, fees distributed)
7 = Cancelled    (proposer cancelled during Draft or Pending)
```

When decoding `getProposal(id)` the last field is this uint8. **Always read the integer against this table, not position order** — the canonical source is `ISyndicateGovernor.sol`.

### BatchExecutorLib.Call

```solidity
struct Call {
    address target;   // contract to call
    bytes data;       // encoded calldata
    uint256 value;    // ETH value to send
}
```

### Governor parameter bounds

| Parameter | Min | Max |
|-----------|-----|-----|
| Voting period | 1 hour | 30 days |
| Execution window | 1 hour | 7 days |
| Veto threshold | 1000 bps (10%) | 10000 bps (100%) |
| Max performance fee | — | 5000 bps (50%) |
| Strategy duration | 1 hour | 365 days |
| Cooldown period | 1 hour | 30 days |

---

## 7. Known Safe Protocols

When evaluating proposal call targets, verify against known protocol addresses **for the chain your syndicate is deployed on**. Addresses differ across chains.

### Base

| Protocol | Address | Notes |
|----------|---------|-------|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 decimals |
| WETH | `0x4200000000000000000000000000000000000006` | Wrapped ETH |
| Moonwell Comptroller | `0xfBb21d0380beE3312B33c4353c8936a0F13EF26C` | Lending |
| Moonwell mUSDC | `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22` | Lending market |
| Moonwell mWETH | `0x628ff693426583D9a7FB391E54366292F509D457` | Lending market |
| Aerodrome Router | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` | ve(3,3) DEX |
| Aerodrome Factory | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` | Pool factory |
| AERO Token | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` | Gauge rewards |
| Uniswap V3 SwapRouter | `0x2626664c2603336E57B271c5C0b26F421741e481` | DEX |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | Batching |

**Strategy template contracts** (deployed per-proposal as ERC-1167 clones) are also valid call targets. Verify the template implementation matches known Sherwood strategy contracts (`MoonwellSupplyStrategy`, `AerodromeLPStrategy`).

### Robinhood L2

| Protocol | Address | Notes |
|----------|---------|-------|
| WETH | `0x7943e237c7F95DA44E0301572D358911207852Fa` | Wrapped ETH |
| SyndicateFactory | `0xea644E2Bc0215fC73B11f52CB16a87334B0922E6` | Sherwood |
| SyndicateGovernor | `0x5cBE8269CfF68D52329B8E0F9174F893627AFf0f` | Sherwood |

> No Moonwell, Uniswap, or Aerodrome on Robinhood L2. Only Sherwood contracts and WETH are deployed.

Calls to addresses NOT in the known list for your chain require extra scrutiny. Verify the contract on the appropriate block explorer before allowing.

---

## Further Reading

- [Governance Overview](https://docs.sherwood.sh/protocol/governance/overview) — Optimistic governance model and proposal lifecycle
- [Settlement](https://docs.sherwood.sh/protocol/governance/settlement) — Settlement paths, emergency actions, P&L calculation
- [Economics](https://docs.sherwood.sh/protocol/governance/economics) — Fee structure and distribution
- [Deployments](https://docs.sherwood.sh/reference/deployments) — Contract addresses by chain
