# sherwood-monitor — Hermes plugin

Turns Sherwood from "a CLI your agent can call" into an always-on fund
management system. The plugin bridges Sherwood's on-chain + XMTP event
stream into Hermes, so a running agent reacts to syndicate activity in
real time, posts summaries back to the syndicate chat, and escalates to
humans via Hermes' existing delivery channels.

## Prerequisites

- Hermes Agent installed
- Node.js 20+ and npm (for Sherwood CLI)
- Sherwood CLI installed globally: `npm i -g @sherwoodagent/cli`
- Sherwood CLI configured: `sherwood config set`

## Install

```bash
hermes plugins install imthatcarlos/sherwood-hermes-plugin
```

## Configure

Edit `~/.hermes/plugins/sherwood-monitor/config.yaml`:

```yaml
syndicates:
  - alpha-fund
  - beta-yield
auto_start: true
xmtp_summaries: true
```

## Usage

Start Hermes:

```bash
hermes
```

The plugin auto-starts monitors for each configured syndicate and injects
a catch-up summary. From chat:

- "start monitoring gamma-fund" → LLM calls `sherwood_monitor_start("gamma-fund")`
- "what's the status of my monitors?" → LLM calls `sherwood_monitor_status()`
- On a new `ProposalCreated`, the agent sees:
  ```
  <sherwood-event syndicate="alpha-fund" source="chain" type="ProposalCreated" ...>
  ```
  and can analyze + respond.

CLI outside chat:

```bash
hermes sherwood status
hermes sherwood start alpha-fund
hermes sherwood tail alpha-fund
```

## What the plugin does

| Event | Plugin behavior |
|---|---|
| On-chain `ProposalCreated` | Inject context + auto-post markdown summary to XMTP |
| On-chain `ProposalExecuted` / `ProposalSettled` / `ProposalCancelled` | Inject + XMTP summary |
| On-chain `VoteCast`, lifecycle events | Inject only (no XMTP post) |
| XMTP `RISK_ALERT` | Inject with `priority="high"` for agent escalation |
| XMTP `APPROVAL_REQUEST` | Inject with `priority="human-escalate"` |
| XMTP plain `MESSAGE` | Inject only when `@`-mention present (configurable) |
| Agent calls `sherwood proposal create/execute/settle` | `pre_tool_call` runs risk checks; `post_tool_call` writes memory |

## Risk checks

When the agent attempts `sherwood strategy propose` or `sherwood proposal create`,
the plugin blocks if any of these fail:

- Position size > 25% of vault AUM
- Total portfolio exposure > 50% of vault AUM
- Protocol not in the vault's configured mandate list

Day-1 limitation: the default state fetcher returns zeros when `sherwood vault info
--json` is unavailable, causing checks to fail-open (permissive). Configure
your mandate explicitly once `vault info` is fully wired.

## Development

```bash
cd hermes-plugin
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest -v
```

Refresh bundled skill pack from the Sherwood repo:

```bash
./scripts/refresh_skill_pack.sh ../skill
```

## License

MIT
