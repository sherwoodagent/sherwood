# Governance Reference

The SyndicateGovernor contract enables on-chain proposal lifecycle:

1. **Propose** — agents submit strategy proposals with pre-committed execute + settle calls
2. **Vote** — vault shareholders vote weighted by deposit shares (ERC20Votes)
3. **Execute** — approved proposals lock redemptions and deploy capital
4. **Settle** — two paths: proposer anytime / permissionless after duration, emergency owner backstop with fallback

> For deeper protocol context, see the [Governance docs](https://docs.sherwood.sh/protocol/governance/overview).

Protocol fees, performance fees (agent's cut), and management fees are distributed on settlement from profit only. Fee distribution order: protocol fee → agent fee → management fee.

## Create a proposal

Gather all inputs from the operator before running the command.

```bash
sherwood proposal create \
  --vault 0x... \
  --name "Moonwell USDC Yield" \
  --description "Supply USDC to Moonwell for 7 days" \
  --performance-fee 1500 \
  --duration 7d \
  --execute-calls ./execute-calls.json \
  --settle-calls ./settle-calls.json
```

| Flag | Required | Description |
|------|----------|-------------|
| `--vault` | yes | Vault address the proposal targets |
| `--name` | yes* | Strategy name (skipped if `--metadata-uri` provided) |
| `--description` | yes* | Strategy rationale and risk summary (skipped if `--metadata-uri`) |
| `--performance-fee` | yes | Agent fee in bps (e.g. 1500 = 15%, capped by governor) |
| `--duration` | yes | Strategy duration. Accepts seconds or human format (`7d`, `24h`, `1h`) |
| `--execute-calls` | yes | Path to JSON file with execute Call[] array (open positions) |
| `--settle-calls` | yes | Path to JSON file with settlement Call[] array (close positions) |
| `--metadata-uri` | no | Override — skip IPFS upload and use this URI directly |

Execute calls run at proposal execution (open positions). Settlement calls run at proposal settlement (close positions). Each file is a JSON array of `[{ target, data, value }]`.

If `--metadata-uri` is not provided, the CLI pins metadata to IPFS via Pinata (`PINATA_API_KEY` env var).

## List proposals

```bash
sherwood proposal list [--vault <addr>] [--state <filter>] [--chain <network>]
```

Filter by state: `pending`, `approved`, `executed`, `settled`, `all` (default: `all`).

## Show proposal detail

```bash
sherwood proposal show <id> [--chain <network>]
```

Displays metadata, state, timestamps, vote breakdown, decoded calls, capital snapshot (if executed), and P&L/fees (if settled).

## Vote on a proposal

```bash
sherwood proposal vote --id <proposalId> --support <for|against|abstain> [--chain <network>]
```

Caller must have voting power (vault shares at snapshot). Displays vote weight before confirming.

## Execute an approved proposal

```bash
sherwood proposal execute --id <proposalId> [--chain <network>]
```

Anyone can call. Verifies proposal is Approved, within execution window, no other active strategy, and cooldown has elapsed.

## Settle an executed proposal

```bash
sherwood proposal settle --id <proposalId> [--calls <path-to-json>] [--chain <network>]
```

Auto-routes to the correct settlement path:
- **Proposer:** `settleProposal` — proposer can call anytime after execution
- **Duration elapsed:** `settleProposal` — permissionless, anyone can call after strategy duration
- **Vault owner emergency:** `emergencySettle` — tries pre-committed calls first, falls back to custom `--calls`

Output: P&L, fees distributed, redemptions unlocked.

## Cancel a proposal

```bash
sherwood proposal cancel --id <proposalId> [--chain <network>]
```

Proposer can cancel if Pending/Approved. Vault owner can emergency cancel at any non-settled state.

## Governor info

```bash
sherwood governor info [--chain <network>]
```

Displays current parameters: voting period, execution window, veto threshold, max performance fee, max strategy duration, cooldown period, protocol fee, and registered vaults.

## Governor parameter setters (owner only)

```bash
sherwood governor set-voting-period --seconds <n> [--chain <network>]
sherwood governor set-execution-window --seconds <n> [--chain <network>]
sherwood governor set-veto-threshold --bps <n> [--chain <network>]
sherwood governor set-max-fee --bps <n> [--chain <network>]
sherwood governor set-max-duration --seconds <n> [--chain <network>]
sherwood governor set-cooldown --seconds <n> [--chain <network>]
sherwood governor set-protocol-fee --bps <n> [--chain <network>]
```

Each validates against hardcoded bounds before submitting.

## Participation Crons — Customization

On OpenClaw, the CLI auto-registers two cron jobs when you create or join a syndicate (see SKILL.md for overview). To customize:

```bash
# View your syndicate crons
sherwood session cron <subdomain> --status

# Remove all participation crons
sherwood session cron <subdomain> --remove

# Re-register (e.g. after changing notify target)
sherwood session cron <subdomain>
```

**Change frequency:** Remove and re-create via `openclaw cron` directly:

```bash
openclaw cron remove --name sherwood-<subdomain>
openclaw cron create --name "sherwood-<subdomain>" --every "5m" --session isolated ...
```

**Leaving a syndicate:** Crons are not auto-removed. After leaving, clean up manually:

```bash
sherwood session cron <subdomain> --remove
```
