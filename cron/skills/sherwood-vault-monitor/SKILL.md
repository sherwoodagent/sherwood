---
name: sherwood-vault-monitor
description: Check the on-chain health of a Sherwood syndicate vault and report only when something is anomalous.
tags: [sherwood, defi, vault, monitoring, cron]
triggers:
  - check sherwood vault health
  - sherwood vault-monitor cron
  - syndicate vault status
---

# Sherwood Vault Health Check

Reads the on-chain state of a Sherwood vault and reports only when
something is anomalous. Designed for fresh-session cron use.

The cron job invoking this skill MUST provide:
- `<VAULT_ADDRESS>` — the vault contract address
- `<CHAIN>` — chain alias (e.g. `hyperevm`, `base`)

If missing, abort with an explicit error.

## Procedure

### 1. Read vault state (CLI)

```bash
sherwood --chain <CHAIN> vault info --vault <VAULT_ADDRESS>
```

Cross-check governance and syndicate context (optional but useful):

```bash
sherwood --chain <CHAIN> proposal list --vault <VAULT_ADDRESS> --state all
sherwood --chain <CHAIN> syndicate info <SYNDICATE_NAME>   # if known
```

Capture:
- Total assets
- Whether redemptions are locked
- Agent count
- Proposal states (pending/approved/executed/settled/cancelled)
- Any RPC/contract errors

### 2. Compare against expected state

A healthy vault on a normal cycle:
- RPC reachable, no contract reverts on basic reads
- Redemptions unlocked (unless an active proposal is mid-execution)
- Agent count ≥ 1 (vault is managed)

**Important — `totalAssets() = 0` is NORMAL** for a vault in
post-settlement state with no fresh deposits. Do NOT alert on a
zero-balance vault. Do NOT attempt to compute "drawdown" against an
inferred prior value — this skill has no authoritative cross-run state
and reconstructing a baseline from chat or session context produces
false positives. Track real value off-chain (or via on-chain events) if
drawdown alerting is needed; that's a future enhancement.

### 3. Anomaly detection

Treat as anomalous and ALERT only if any of:
- Redemptions are LOCKED but NO proposal is currently in `Executed` state
  (means redemptions are stuck; investigate the governor)
- Agent count = 0 (vault is unmanaged)
- RPC unreachable, or core reads (`totalAssets`, `redemptionsLocked`,
  `getAgentCount`) revert
- Vault address resolves to a non-vault contract (selector mismatch,
  unexpected return shapes)

## Output policy (anomaly-only)

- **Healthy** — respond with EXACTLY one line: `[SILENT]`
- **Anomalous** — respond with `🚨 VAULT ALERT:` followed by:
  - What changed (specific values)
  - Suggested next action (`sherwood vault info` for manual inspection,
    or proposal investigation)

## Notification hook (if alerting)

If posting to XMTP for alerts only, use `--stdin`:

```bash
printf '%s' '🚨 VAULT ALERT: redemptions locked but no Executed proposal — investigate.' \
  | sherwood --chain <CHAIN> chat <SYNDICATE_NAME> send --stdin
```

## On-chain verification (recommended)

Use direct RPC calls to validate CLI output and detect silent parser issues:

```bash
RPC_URL=<your chain RPC, e.g. https://rpc.hyperliquid.xyz/evm>
VAULT=<VAULT_ADDRESS>

cast block-number --rpc-url "$RPC_URL"
cast call "$VAULT" 'totalAssets()(uint256)'      --rpc-url "$RPC_URL"
cast call "$VAULT" 'totalSupply()(uint256)'       --rpc-url "$RPC_URL"
cast call "$VAULT" 'redemptionsLocked()(bool)'    --rpc-url "$RPC_URL"
cast call "$VAULT" 'getAgentCount()(uint256)'     --rpc-url "$RPC_URL"
```

Use `getAgentCount()` for reliability (some deployments may revert on `agentCount()`).

## Pitfalls

- `vault info` and `proposal list` expect `--vault`; `--subdomain` is unsupported.
- Distinguish true RPC failures from contract-function-level reverts.
- Keep alerting anomaly-only; healthy runs MUST output exactly `[SILENT]`.

## Idempotency

Read-only operation. Safe to re-run any number of times. No state mutation.
