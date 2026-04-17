---
name: sherwood-proposal-monitor
description: Monitor Sherwood syndicate vault proposals and surface only proposals that need execution, settlement, or attention.
tags: [sherwood, governance, proposals, monitoring, cron]
triggers:
  - check sherwood proposals
  - sherwood proposal-monitor cron
  - vault proposal status
---

# Sherwood Proposal Lifecycle Monitor

Reads all proposals on a Sherwood vault and surfaces only those that
need action. Silent when nothing actionable.

The cron job invoking this skill MUST provide:
- `<VAULT_ADDRESS>` — the vault contract address
- `<CHAIN>` — chain alias (e.g. `hyperevm`, `base`)

## Procedure

### 1. List proposals

```bash
sherwood --chain <CHAIN> proposal list --vault <VAULT_ADDRESS>
```

### 2. Classify each proposal

For every proposal returned, determine its state:
- `Pending` — within voting window, no action needed
- `Approved` — voting ended, ready to execute
- `Executed` — strategy active, may need settlement when duration elapses
- `Settled` — closed, archived
- `Rejected` — vetoed, archived

### 3. Identify actionable proposals

Surface only:
- `Approved` → ready to execute now
- `Executed` and strategy duration has elapsed → ready to settle
- `Failed execution` (revert in last attempt) → needs investigation

For each actionable proposal, include:
- Proposal ID
- Name / type
- State
- The exact CLI command to take the next action

## Output policy (action-only)

- **Nothing actionable** — respond with EXACTLY one line: `[SILENT]`
- **Action required** — respond with `📋 PROPOSAL ACTION:` followed by
  one line per actionable proposal:
  - `READY TO EXECUTE: Proposal #X — <name>. Run: sherwood --chain <CHAIN> proposal execute --id X`
  - `READY TO SETTLE: Proposal #X — <name>. Run: sherwood --chain <CHAIN> proposal settle --id X`
  - `EXECUTION FAILED: Proposal #X — <name>. Investigate logs.`

## Notification hook (if alerting)

If posting to XMTP for action items, use `--stdin`:

```bash
printf '%s' '📋 PROPOSAL ACTION: READY TO EXECUTE Proposal #5 ...' \
  | sherwood --chain <CHAIN> chat <SYNDICATE_NAME> send --stdin
```

## Idempotency

Read-only. Re-running this skill is safe. Do NOT auto-execute or
auto-settle from this skill — only report.
