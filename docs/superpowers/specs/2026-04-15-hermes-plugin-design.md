# Hermes Plugin for Sherwood — Design Spec

**Date:** 2026-04-15
**Status:** Design approved, ready for implementation plan
**Related:** [sherwood#151](https://github.com/sherwoodagent/sherwood/issues/151)

## Goal

Ship a complete, out-of-the-box Hermes plugin (`sherwood-monitor`) that turns Sherwood from "a CLI your agent can call" into an always-on fund management system. The plugin bridges Sherwood's event stream (on-chain + XMTP) into Hermes' plugin/hook architecture so a running Hermes agent reacts to syndicate activity in real time, posts summaries back to the syndicate chat, and escalates to humans via Hermes' existing delivery channels.

Scope covers Phases 1 and 2 of the original issue (streaming subprocess + tools + hooks + event routing + pre/post_tool_call interception + memory writes). Phase 3 (autonomous strategy proposal generation) is explicitly deferred.

## Non-goals

- Autonomous on-chain actions without LLM in the loop. The plugin routes information; the Hermes agent decides.
- Replacing Sherwood's CLI. The plugin is a thin consumer of `sherwood session check --stream` output.
- Managing cursor state. Sherwood's CLI owns session cursors at `~/.sherwood/sessions/`.
- Direct Telegram/Discord delivery. Human escalation flows through Hermes' existing gateway.
- Phase 3 features: auto-generated proposals, learned-pattern strategy authoring.

## Repository layout

The plugin lives in a new standalone repo (`sherwoodagent/sherwood-hermes-plugin`) added as a git submodule to the Sherwood monorepo at `hermes-plugin/`, mirroring the existing `mintlify-docs/` submodule pattern. This keeps the plugin developable in-context while allowing independent versioning and distribution via `hermes plugins install sherwoodagent/sherwood-hermes-plugin`.

Plugin directory structure:

```
sherwood-hermes-plugin/
├── plugin.yaml
├── __init__.py              # register(ctx)
├── schemas.py               # tool schemas
├── tools.py                 # tool handlers (start/stop/status)
├── supervisor.py            # subprocess lifecycle
├── router.py                # EventRouter (pure dispatch)
├── handlers.py              # per-event-type handler functions
├── config.py                # config.yaml loader/validator
├── preflight.py             # sherwood CLI check
├── BOOT.md                  # Hermes startup routine
├── skills/
│   └── sherwood-agent/      # bundled skill pack (mirrored)
├── fixtures/
│   ├── chain_proposal_created.json
│   ├── chain_proposal_settled.json
│   ├── xmtp_risk_alert.json
│   └── ...                  # golden stream fixtures for tests
├── tests/
│   ├── test_router.py
│   ├── test_supervisor.py
│   ├── test_handlers.py
│   └── test_config.py
├── pyproject.toml
└── README.md
```

## Architecture

Three components running inside the Hermes process as a single asyncio task group:

1. **Supervisor** — manages one `sherwood session check <sub> --stream` subprocess per monitored syndicate. Reads `stdout` line-by-line via `asyncio.StreamReader`, decodes JSON, pushes into a bounded queue. Drains `stderr` to a 200-line ring buffer for the `status` tool. On subprocess exit, applies exponential backoff (`min(30, 2**n)` seconds, reset counter after 60s of stable run).

2. **EventRouter** — pure-function dispatch layer. Takes a decoded record, looks up the event type in the routing table, calls the registered handler(s). Handlers are side-effecting: they call `ctx.inject_message()` and/or fire-and-forget `sherwood chat <sub> send --markdown`. All failures log and continue — never crash the plugin.

3. **Plugin API surface** — the thin outer layer. `register(ctx)` registers tools, hooks, CLI commands, the skill pack, runs preflight, and starts the Supervisor if `auto_start` is true. Module-level singletons hold Supervisor state.

Data flow for a single event:

```
on-chain tx or XMTP message
  ↓
`sherwood session check <sub> --stream` (subprocess)
  ↓ JSON line on stdout
Supervisor.readline → decode → push to queue
  ↓
EventRouter.route(record)
  ↓
handlers.on_<event_type>(ctx, record)
  ↓ ↓
inject_message(ctx,    sherwood chat <sub>
  structured block)    send --markdown "..."
  ↓                    (fire-and-forget subprocess)
Hermes LLM sees
event on next turn
  ↓
(optional) LLM calls
  sherwood CLI via
  terminal tool
  ↓
pre_tool_call hook
  validates
  ↓
(Phase 2) post_tool_call
  writes to memory
```

## Plugin surface

### Configuration

File: `~/.hermes/plugins/sherwood-monitor/config.yaml`

```yaml
syndicates:
  - alpha-fund           # subdomain
  - beta-yield
auto_start: true         # start supervisors on plugin load
xmtp_summaries: true     # allow auto-posting summaries to XMTP groups
sherwood_bin: sherwood   # override path if not on $PATH
backoff_max_seconds: 30  # max exponential backoff between restarts
inject_mentions_only: true  # XMTP MESSAGE type only injected when agent @-mentioned
```

If `config.yaml` is missing on first load, the plugin creates a stub with empty `syndicates: []` and `auto_start: false`, and logs a one-time message telling the user to edit it. Preflight still runs.

### Tools (LLM-callable)

| Tool | Args | Returns |
|---|---|---|
| `sherwood_monitor_start` | `subdomain: str` | `{"started": true, "pid": <int>}` or `{"error": "..."}` |
| `sherwood_monitor_stop` | `subdomain: str` | `{"stopped": true}` or `{"error": "..."}` |
| `sherwood_monitor_status` | (none) | `{"syndicates": [{"subdomain", "pid", "uptime_seconds", "events_seen", "last_event_at", "stderr_tail": [..]}, ...]}` |

All handlers accept `args: dict, **kwargs` and return JSON strings, per Hermes convention. Never raise.

### Hooks

| Hook | Purpose | Phase |
|---|---|---|
| `on_session_start` | Run catch-up: call `sherwood session check <sub>` once per monitored syndicate and inject a summary block. Ensures Hermes agent has context on startup. | 1 |
| `on_session_end` | Graceful SIGTERM to all subprocesses, wait 5s, SIGKILL stragglers. | 1 |
| `pre_tool_call` | Fires for every tool call. Plugin filters by: `tool_name in {"terminal", "bash", "shell"}` AND `params.get("command", "")` matches a compiled regex `sherwood\s+(strategy\s+propose\|proposal\s+create)`. On match, parse the subdomain from the command, run risk checks (portfolio exposure, mandate compliance, position sizing), return `{"blocked": True, "reason": "..."}` on failure. All other tool calls pass through untouched. | 2 |
| `post_tool_call` | Same filter pattern, matching `sherwood\s+proposal\s+(execute\|settle)`. Writes a memory record `{syndicate, event_type, timestamp, outcome, tx_hash, pnl?}` via Hermes memory API. Never blocks (return value ignored per Hermes spec). | 2 |

### CLI commands

Registered via `ctx.register_cli_command`:

- `hermes sherwood start <subdomain>` — same as tool
- `hermes sherwood stop <subdomain>` — same as tool
- `hermes sherwood status` — pretty-printed table of supervisor state
- `hermes sherwood tail <subdomain> [--stderr]` — tail supervisor stdout/stderr ring buffer

### Skill pack

`ctx.register_skill("sherwood-agent", "./skills/sherwood-agent")` registers the bundled Sherwood skill pack. The pack is a mirror of the existing `sherwood-agent` skill from the main Sherwood repo, checked into the plugin repo at plugin build time (not a nested submodule — too fragile). A CI job on the plugin repo refreshes the mirror against Sherwood `main` and opens a PR if diffs appear.

### BOOT.md

At install time, `register()` writes `~/.hermes/plugins/sherwood-monitor/BOOT.md`:

```markdown
# Sherwood Monitor — Boot

For each syndicate in ~/.hermes/plugins/sherwood-monitor/config.yaml:

1. Call `sherwood_monitor_status()` and report each syndicate's state.
2. If auto_start is true and a syndicate has no live supervisor, call
   `sherwood_monitor_start(subdomain)`.
3. Note any event summaries injected during `on_session_start` catch-up.
```

Hermes executes BOOT.md at startup using the gateway's resolved model/runtime configuration.

## Event routing table

| Source | Event type | Inject to Hermes | Auto-post to XMTP | Notes |
|---|---|---|---|---|
| chain | `ProposalCreated` | yes (full args + IPFS metadata) | yes (markdown) | Metadata already enriched by CLI |
| chain | `VoteCast` | yes (compact) | no | Running tally; agent decides if veto threshold near |
| chain | `ProposalExecuted` | yes | yes | "Capital deployed: $X" |
| chain | `ProposalSettled` | yes (pnl, duration) | yes | Triggers memory write (Phase 2 handler) |
| chain | `ProposalCancelled` | yes | yes | |
| chain | `AgentRegistered` | yes | no | Welcome is agent's call |
| chain | `AgentRemoved` | yes | no | |
| chain | `DepositorApproved` / `DepositorRemoved` | yes | no | |
| chain | `RedemptionsLockedEvent` / `RedemptionsUnlockedEvent` | yes | no | |
| xmtp | `RISK_ALERT` | yes (priority=high) | no | Hermes gateway handles human escalation |
| xmtp | `STRATEGY_PROPOSAL` | yes | no | Agent pre-analyzes before on-chain proposal |
| xmtp | `APPROVAL_REQUEST` | yes (human-escalate marker) | no | |
| xmtp | `TRADE_SIGNAL` | yes | no | |
| xmtp | `POSITION_UPDATE` / `LP_REPORT` / `TRADE_EXECUTED` | yes (compact) | no | Context only |
| xmtp | `MEMBER_JOIN` / `RAGEQUIT_NOTICE` / `AGENT_REGISTERED` | yes | no | Lifecycle |
| xmtp | `MESSAGE` / `REACTION` | only if agent @-mentioned AND `inject_mentions_only: true` | no | Avoid flooding LLM |
| xmtp | `X402_RESEARCH` | yes | no | |

Injection uses `ctx.inject_message(content=block, role="user")`. Events arrive asynchronously from the subprocess whenever on-chain or XMTP activity occurs; the queued message is visible to the LLM on its next turn. Structured as:

```
<sherwood-event syndicate="alpha-fund" source="chain" type="ProposalCreated" priority="normal">
<args>
  proposalId: 42
  proposer: 0xabc…
  performanceFeeBps: 1000
  strategyDuration: 604800
  metadata: {name: "Aerodrome USDC-ETH LP", description: "..."}
</args>
</sherwood-event>
```

The Sherwood skill pack documents this tag so the agent recognizes it as authoritative plugin output.

## Subprocess supervisor details

```python
async def supervise(subdomain: str, state: SyndicateState):
    backoff = 1
    while not state.stop_requested:
        proc = await asyncio.create_subprocess_exec(
            state.sherwood_bin, "session", "check", subdomain, "--stream",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        state.proc = proc
        state.started_at = time.time()

        stdout_task = asyncio.create_task(_read_stdout(proc.stdout, state))
        stderr_task = asyncio.create_task(_drain_stderr(proc.stderr, state))

        rc = await proc.wait()
        stdout_task.cancel()
        stderr_task.cancel()

        if state.stop_requested:
            return

        if time.time() - state.started_at > 60:
            backoff = 1  # stable run, reset

        await asyncio.sleep(backoff)
        backoff = min(state.backoff_max, backoff * 2)
```

`_read_stdout` reads lines, decodes JSON, calls `router.route(subdomain, record)`. Malformed JSON logs and continues.

`_drain_stderr` appends lines to a 200-line `collections.deque(maxlen=200)` for the `status` tool.

On `on_session_end`: iterate all states, set `stop_requested=True`, send SIGTERM. Wait 5s via `asyncio.wait_for(proc.wait(), timeout=5)`; if timeout, send SIGKILL.

## State

Plugin-local state file: `~/.hermes/plugins/sherwood-monitor/state.json`. Contains only:

```json
{
  "last_monitored": ["alpha-fund", "beta-yield"]
}
```

Written on every start/stop tool call. Read on plugin load to auto-resume (filtered against `config.yaml` allowlist).

No cursor state — Sherwood CLI owns that in `~/.sherwood/sessions/`. Memory writes from `post_tool_call` go through Hermes' memory API, not a plugin-local store.

## Dependencies

- Python 3.11+ (Hermes requirement)
- `asyncio` (stdlib)
- `PyYAML` for `config.yaml`
- Sherwood CLI installed globally: `npm i -g @sherwoodagent/cli`, minimum version pinned in `config.py` (initial: `0.4.0`)
- Sherwood CLI configured: `sherwood config set` with wallet + RPC

Preflight (`preflight.py`) runs on `register()`:
1. Check `sherwood --version` via `subprocess.run(["sherwood", "--version"], capture_output=True)`. If fails, log warning and inject one-time message prompting `npm i -g @sherwoodagent/cli`.
2. Check `~/.sherwood/config.json` exists. If not, log warning about `sherwood config set`.
3. Neither failure prevents plugin load — the tools will simply return errors until resolved.

## Testing strategy

- **EventRouter:** unit-tested by feeding `fixtures/*.json` records, asserting correct `inject_message` + `chat send` calls via mocks. No asyncio, no subprocesses.
- **Supervisor:** stub `asyncio.create_subprocess_exec` with a mock that emits a fixture stream and exits. Assert backoff behavior by making the stub exit multiple times in rapid succession.
- **Handlers:** per-event-type unit tests, mocking `ctx` and `subprocess.run` for XMTP posts.
- **Config:** YAML parse error paths, missing file path, default population.
- **Preflight:** mock `subprocess.run` to simulate missing CLI, missing config.
- **Live integration test** (manual, documented in README): spin up Hermes with the plugin pointed at a testnet syndicate, propose on-chain, observe `inject_message` + XMTP summary.

`pytest` with `pytest-asyncio` for the supervisor tests. CI runs unit tests only.

## Installation and first-run UX

User flow:

```
$ hermes plugins install sherwoodagent/sherwood-hermes-plugin
✓ Installed sherwood-monitor v0.1.0

$ hermes
[plugin] sherwood-monitor: preflight passed
[plugin] sherwood-monitor: no syndicates configured
[plugin] sherwood-monitor: edit ~/.hermes/plugins/sherwood-monitor/config.yaml to add syndicates

> Hi, what can you help me with today?
```

After the user edits `config.yaml` and restarts (or calls `sherwood_monitor_start(...)` via chat):

```
[plugin] sherwood-monitor: starting supervisor for alpha-fund
[plugin] sherwood-monitor: starting supervisor for beta-yield
[plugin] sherwood-monitor: catch-up — 3 new events for alpha-fund
[plugin] sherwood-monitor: catch-up — 0 new events for beta-yield

> [injected] <sherwood-event syndicate="alpha-fund" source="chain" type="ProposalCreated" ...>

Agent: I see a new proposal on alpha-fund for an Aerodrome USDC-ETH LP strategy.
Let me analyze the risk profile...
```

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Sherwood CLI version drift breaks event schema | Pin min CLI version in config; preflight rejects older versions with upgrade instructions |
| Subprocess leaks on Hermes crash | `on_session_end` + `atexit` + `SIGTERM` handler; Hermes' own lifecycle handles SIGKILL |
| RPC rate limits from many syndicates | Not plugin's problem — CLI already throttles at 30s polls; plugin spawns one subprocess per syndicate, which the user controls |
| LLM flooding from chatty XMTP groups | `inject_mentions_only: true` default for `MESSAGE` type; explicit allowlist per event type in router |
| Auto-posting XMTP summaries creates feedback loops | CLI `session check` already filters own messages by `xmtpInboxId`; plugin posts use the same identity |
| Phase 2 risk checks are wrong and block legitimate proposals | Risk check logic is conservative, documented, and overridable via config; all blocks include `reason` so agent can work around |

## Open questions deferred to implementation

- Exact risk check rules in `pre_tool_call` (portfolio exposure threshold, mandate compliance logic) — scoped in the implementation plan.
- Memory schema for `post_tool_call` settlement writes — scoped in the implementation plan.
- Whether to ship an example `config.yaml` in the install payload or generate on first load — lean toward generate.
