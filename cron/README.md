# Sherwood Cron Jobs

Operational cron jobs for running the Sherwood paper-trading agent and
monitoring a deployed syndicate vault. Designed for the [Hermes Agent](https://github.com/NousResearch/hermes-agent)
runtime — but the SKILL.md files are portable and work with any LLM agent
that supports skills (OpenClaw, Claude Code, etc.).

## What this gives you

Four scheduled jobs that run in the background once installed:

| Job | Cadence | What it does |
|---|---|---|
| **sherwood-trade-scanner** | every 15 min | Runs one paper-trading cycle, posts a summary to the syndicate XMTP chat |
| **sherwood-vault-monitor** | every 2 h | Checks vault on-chain state, alerts only on anomalies (silent if healthy) |
| **sherwood-proposal-monitor** | every 4 h | Lists vault proposals, surfaces only those needing execution / settlement |
| **sherwood-xmtp-checker** | every 2 h | Reads syndicate chat, surfaces only direct asks from other members |

The monitor jobs follow an **anomaly-only** policy — they output exactly
`[SILENT]` when nothing is wrong, so your cron channel stays quiet
between actual events.

## Prerequisites

- **Hermes Agent** installed and the gateway daemon running
  - `hermes status` should report `Gateway is running`
  - `hermes cron list` should work
- **Sherwood CLI ≥ 0.40.2** on `PATH` (`which sherwood && sherwood --version`)
  - 0.40.2 added the `chat send --stdin` flag that the trade-scanner skill relies on
- **A deployed syndicate** with an XMTP chat — you'll need the vault address
  and the chat name
- **Always-on host** — laptop sleep = missed cron runs. Use VPS / Docker / systemd

## Install

From the repo root:

```bash
./cron/install.sh
```

The installer is interactive (or env-var driven) and will:

1. Verify Hermes + Sherwood CLI are installed and version-compatible
2. Prompt for: `REPO_DIR`, `SYNDICATE_NAME`, `CHAIN`, `VAULT_ADDRESS`, `AGENT_WALLET`
3. Copy the four `cron/skills/<name>/SKILL.md` files into `~/.hermes/skills/sherwood/`
4. Verify each directory name matches the frontmatter `name:` (Hermes resolves
   skills by directory name, not frontmatter — see Gotchas below)
5. Render `cron/jobs.example.json` with your values and register the four
   jobs via `hermes cron create`
6. Skip any job that already exists (idempotent re-runs)

You can also drive it non-interactively:

```bash
REPO_DIR=$HOME/code/sherwood \
SYNDICATE_NAME=hyperliquid-algo \
CHAIN=hyperevm \
VAULT_ADDRESS=0x9cC32B1a04c4ae5236a29e69fedFD468AA97F83F \
AGENT_WALLET=0x5A00afAecE9CF61A768E2AE2713084C8d354DF94 \
./cron/install.sh
```

## Verify

```bash
hermes cron list                          # 4 active jobs
hermes cron run <job-id>                  # trigger one tick to test
ls -t ~/.hermes/sessions/session_cron_*.json | head -4
```

In a fresh cron session JSON, the user message should contain:

```
[SYSTEM: The user has invoked the "sherwood-vault-monitor" skill, indicating
you want to follow its instructions. The full skill content is loaded below.]
```

If you see `⚠️ Skill(s) not found and skipped`, the skill directory name
does not match its frontmatter `name:`. Re-run `install.sh` (it validates).

## Gotchas (read these before debugging)

### 1. Skill resolution is by directory name

Hermes' `skill_view(name)` walks `~/.hermes/skills/**/SKILL.md` and matches
on `parent_dir.name == name`. The `name:` field in the frontmatter is **not
used for lookup**. If you place a skill at `~/.hermes/skills/foo/bar/SKILL.md`
with frontmatter `name: foo-bar`, the lookup `--skill foo-bar` will fail
because the parent dir is `bar`. The installer enforces matching names.

### 2. Bash `$`-expansion mangles XMTP messages

```bash
# WRONG — bash expands $10 (empty positional arg) and $0 (script name)
sherwood chat <name> send "Portfolio $10,000, PnL $0.00"
# Result: "Portfolio 0,000, PnL /usr/bin/bash.00"

# RIGHT — single-quoted printf + --stdin bypasses shell tokenization
printf '%s' 'Portfolio $10,000, PnL $0.00' \
  | sherwood --chain <CHAIN> chat <SYNDICATE_NAME> send --stdin
```

The `--stdin` flag was added in CLI **0.40.2** specifically for cron use.

### 3. `totalAssets() = 0` is normal post-settlement

The vault-monitor skill explicitly does NOT alert on a zero-balance vault.
A vault that has just settled and not been re-funded reads `totalAssets() = 0`
on chain — that's expected. We do not maintain cross-run state to compare
against a "prior known balance". If you want true drawdown alerting, ingest
on-chain `Deposit` / `Withdraw` / `Settle` events to a state file.

### 4. Cron sessions are fresh — assume zero context

Every cron tick spawns a brand new agent session. Skills must be entirely
self-contained. Do not reference "as I mentioned earlier" or expect any
session memory between runs.

### 5. The CLI binary is symlinked into the local checkout

If you installed via `npm i -g @sherwoodagent/cli`, the global `sherwood`
binary is a symlink into the npm package. If you installed via `npm link`
in the local checkout, `npm run build` is enough to deploy code changes —
no `npm i -g` re-install needed. Cron picks up rebuilds on the next tick.

### 6. Hermes config timeout

Default `script_timeout_seconds` is 120. The trade-scanner can take
2–4 minutes when the Hyperliquid dynamic-selection path is slow. Bump
the timeout in `~/.hermes/config.yaml`:

```yaml
cron:
  wrap_response: true
  script_timeout_seconds: 300
```

## Customizing

### Schedule

Each job's cadence is set by the `schedule.minutes` field in
`jobs.example.json`. Stagger jobs of similar cadence so they don't fire on
the same boundary:

```bash
# Shift one job's anchor without re-creating it
hermes cron edit <job-id> --schedule "every 120m"
```

(Hermes anchors interval jobs from the time of `edit` / `create` — re-edit
to shift.)

### Per-job model

Hermes runs every cron job with the default model from
`~/.hermes/config.yaml`. You can edit `~/.hermes/cron/jobs.json` directly
and add a `model:` and `provider:` field per job, but only providers in
`~/.hermes/auth.json` will work.

### Disable a job temporarily

```bash
hermes cron pause <job-id>
hermes cron resume <job-id>
```

### Replace a skill

Edit the SKILL.md in `cron/skills/<name>/`, then re-run `./cron/install.sh`.
The installer overwrites existing skill files but does not touch already-
registered cron jobs (so your schedule and prompt-overrides survive).

## File layout

```
cron/
├── README.md              ← you are here
├── install.sh             ← interactive installer
├── jobs.example.json      ← cron job templates with <PLACEHOLDERS>
└── skills/
    ├── sherwood-trade-scanner/SKILL.md
    ├── sherwood-vault-monitor/SKILL.md
    ├── sherwood-proposal-monitor/SKILL.md
    └── sherwood-xmtp-checker/SKILL.md
```

## Uninstall

```bash
hermes cron list                          # find the IDs
hermes cron remove <job-id>               # repeat for each
rm -rf ~/.hermes/skills/sherwood          # remove the skills
```

## See also

- Project root `CLAUDE.md` — repo conventions, CLI ops, agent state files
- `~/.claude/rules/cron-best-practices.md` — generic Hermes cron patterns
  (if you maintain a `~/.claude/rules/` folder)
