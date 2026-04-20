# Hermes Plugin Phase 3 — Design Spec

**Date:** 2026-04-16
**Status:** Design draft, pending review
**Related:** [sherwood#151](https://github.com/sherwoodagent/sherwood/issues/151), [sherwood#224](https://github.com/sherwoodagent/sherwood/pull/224), prior spec [docs/superpowers/specs/2026-04-15-hermes-plugin-design.md](2026-04-15-hermes-plugin-design.md)

## Goal

Complete the `sherwood-monitor` plugin with the remaining capabilities from issue #151: true autonomous always-on monitoring, cross-syndicate exposure tracking, and durable institutional-knowledge memory writes. Scoped to ship on top of the existing Phase 1+2 codebase without restructuring.

## Background — what the Hermes architecture actually allows

Researching the Hermes plugin guide post-Phase-1/2 surfaced constraints that reshape what "always-on" means in this runtime:

- **Plugin hooks are reactive.** They fire on lifecycle events (`on_session_start`, `pre_llm_call`, `pre/post_tool_call`, etc.) but have no mechanism to inject messages when no user interaction is underway. Events arriving asynchronously from the Phase 1 streaming subprocess buffer silently until the next `pre_llm_call`, where a plugin can return a `{"context": "..."}` dict to append to the user's message.
- **The real autonomous primitive is cron.** "The gateway ticks the scheduler every 60 seconds, running any due jobs in isolated agent sessions." Each run is a fresh session; results are delivered through Hermes' gateway (Telegram, Discord, email), not back into the user's chat.
- **Memory writes are agent-owned, not plugin-owned.** The agent interacts with memory through its own `memory` tool (`add` / `replace` / `remove`). Plugins influence memory by surfacing context the agent then decides to persist — they do not write memory directly.

Phase 3 aligns with these realities rather than fighting them.

## Phase 3 feature set

### 3.1 Cron-based autonomous monitor (the actual "always-on")

Register a Hermes cron job at plugin install time that runs every 15 minutes. Each tick:
1. For each configured syndicate, run `sherwood session check <sub>` (one-shot, not streaming).
2. Parse the JSON payload; filter for "interesting" events since the last run:
   - Any `ProposalCreated` / `ProposalSettled` / `ProposalCancelled`
   - Any `RISK_ALERT` / `APPROVAL_REQUEST` XMTP message
   - `VoteCast` when the running tally crosses the veto threshold
3. When any interesting event is found, format a digest and deliver it via the cron job's configured target (Telegram/Discord per user's Hermes setup). No digest is sent when nothing is noteworthy — avoids notification spam.

Implementation notes:
- Hermes' cron API is the `cronjob` tool, not `ctx.register_cron()`. The plugin registers a one-time installer at `on_session_start` that checks for and creates the monitor cron if absent. Creation idempotent by cron name (`sherwood-monitor-<nonce>`).
- Since cron runs in an isolated session, it re-reads the plugin's `config.yaml` to find syndicates. No shared state with the in-session supervisor.
- Interesting-event cursor persisted at `~/.hermes/plugins/sherwood-monitor/cron_cursor.json` keyed by subdomain (last block + last message timestamp).
- The cron's prompt includes the configured syndicates and a call-to-action: "For each listed syndicate, call `sherwood_monitor_cron_tick(subdomain)` and summarize any returned events. Deliver the summary to this cron's target."

### 3.2 Cross-syndicate exposure tracking

New module `exposure.py`:
- `aggregate_exposure(syndicates: list[str])` — calls `sherwood vault info <sub> --json` per syndicate, sums positions by protocol, returns `{total_aum_usd, by_protocol: {name: usd}, concentration_pct: {name: float}}`.
- `check_concentration(agg, threshold_pct=30)` — returns a list of `ConcentrationAlert(protocol, pct, syndicates_exposed)` for any protocol over the threshold.

New tool:
- `sherwood_monitor_exposure()` — LLM-callable. Returns aggregated exposure JSON. Lets the agent answer "what's my total Aerodrome exposure across funds?" in one call.

Cron integration:
- The 15-minute cron tick also runs `check_concentration`. Any new alert (not previously flagged at that level) is added to the digest.

Assumes `sherwood vault info <sub> --json` exists and returns structure compatible with our `state_fetcher.py`. If it doesn't exist, Phase 3 has a prerequisite task to add it to the Sherwood CLI.

### 3.3 Settlement memory surfacing (agent-side)

Replace the current `stderr_memory_writer` stub with a better architectural approach:

- **New plugin skill** bundled at `skills/sherwood-agent/skills/remember-settlement.md`. Instructs the agent, after seeing a settlement event, to call its `memory` tool with an entry like:
  ```
  Syndicate alpha-fund — strategy "Aerodrome USDC-ETH LP" settled +$1,500 over 7d on 2026-04-15.
  ```
  The skill provides the exact `memory` tool invocation template.
- **Enhanced `post_tool_call` hook.** When the hook fires on `sherwood proposal settle`, it calls `pre_llm_call`-style context injection on the next turn via a module-level queue (drained on `pre_llm_call`). Injection format: `<sherwood-settlement syndicate="..." strategy="..." pnl_usd="..." duration_days="...">REMEMBER THIS.</sherwood-settlement>`.
- **Rationale.** Plugin can't write memory directly; but it can make the event very legible to the agent so the agent's own memory tool captures it with high fidelity.

### 3.4 Retrofit: replace `ctx.inject_message` with `pre_llm_call` context injection

Phase 1/2 uses `ctx.inject_message(content=..., role="user")` in `handlers.py` and `hooks.py`. This API is not present in the current Hermes plugin authoring guide. Phase 3 retrofits to the documented path:

- A module-level `EventBuffer` (thread-safe `deque`) accumulates `<sherwood-event>` blocks from the streaming subprocess.
- The plugin registers a `pre_llm_call` handler. On each fire, it drains the buffer and returns `{"context": "\n\n".join(blocks)}` to inject accumulated events into the user's next turn.
- `handle_chain_event` and `handle_xmtp_message` in Phase 1 switch from calling `ctx.inject_message(...)` to pushing into the `EventBuffer`.
- The existing tests keep mocking `ctx.inject_message`; the retrofit introduces a new abstraction `ctx.enqueue_event(block)` (backed by the buffer) that tests mock instead. Reduces churn.

This is arguably a Phase 1/2 bug, but shipping it as part of Phase 3 avoids destabilizing the merged PR. Flagged prominently in the plan.

## Non-goals

- **Auto-generated strategy proposals from learned patterns.** The original Phase 3 list included this; it remains speculative. Require real-world syndicate data, backtesting, and safety review before any autonomous proposal generation can ship. Explicitly deferred to a future phase.
- **Replacing Hermes' built-in memory system.** We surface context for the agent's memory tool — we don't build a parallel memory store.
- **Cross-platform gateway delivery.** Phase 3 relies on whatever delivery target the user configures for the cron job. The plugin doesn't own delivery.
- **Rewriting the supervisor / streaming subprocess.** Phase 1's streaming path stays; Phase 3 just fixes the injection retrofit. The streaming path is still the lowest-latency way to surface events during active conversations.

## Architecture changes

New files:
- `sherwood_monitor/exposure.py` — cross-syndicate aggregation
- `sherwood_monitor/cron_installer.py` — idempotent cron setup
- `sherwood_monitor/event_buffer.py` — thread-safe `EventBuffer` for `pre_llm_call` injection
- `skills/sherwood-agent/skills/remember-settlement.md` — agent-side memory guidance
- `fixtures/vault_info_*.json` — golden fixtures for exposure tests
- `tests/test_exposure.py`
- `tests/test_cron_installer.py`
- `tests/test_event_buffer.py`

Modified files:
- `sherwood_monitor/handlers.py` — swap `ctx.inject_message` for `ctx.enqueue_event`
- `sherwood_monitor/hooks.py` — add `make_pre_llm_call_hook(buffer)`; remove direct `inject_message` calls
- `sherwood_monitor/schemas.py` + `sherwood_monitor/tools.py` — add `sherwood_monitor_exposure` tool
- `sherwood_monitor/__init__.py` — register new hook + tool, start cron installer
- `sherwood_monitor/state_fetcher.py` — reuse parse logic in exposure.py (extract shared `parse_vault_info()`)
- `README.md` — document cron behavior, delivery targets, new tool

## Data flow additions

### Cron tick (autonomous)
```
Hermes gateway tick (60s)
  → cron scheduler finds sherwood-monitor-<nonce> due
  → spawns isolated Hermes session with cron prompt
  → agent calls sherwood_monitor_cron_tick(sub) per configured syndicate
  → tick returns {new_events: [...], concentration_alerts: [...]}
  → agent composes digest
  → digest delivered to Telegram/Discord via gateway
```

### In-session event (retrofit)
```
`sherwood session check --stream` emits line
  → Supervisor.readline → decode → EventRouter.route
  → handlers.handle_chain_event / handle_xmtp_message
  → ctx.enqueue_event(block)        ← instead of ctx.inject_message
  → EventBuffer grows
  → next user turn fires pre_llm_call
  → pre_llm_call drains EventBuffer → returns {"context": blocks}
  → LLM sees events in its next turn
```

### Settlement (memory surfacing)
```
agent calls `sherwood proposal settle alpha 42`
  → post_tool_call hook parses result JSON
  → builds <sherwood-settlement> block
  → ctx.enqueue_event(block)        ← same buffer as events
  → next pre_llm_call injects it with "REMEMBER THIS" marker
  → remember-settlement skill primes agent to use memory tool
  → agent calls memory(action="add", ...) to persist
```

## Testing strategy

- **Pure units (fast):** `exposure.py` with mocked `sherwood vault info` JSON; `event_buffer.py` thread-safety under concurrent push/drain; `cron_installer.py` idempotency.
- **Hook retrofit:** `test_handlers.py` updated to assert `ctx.enqueue_event` instead of `ctx.inject_message`. The count assertions and content checks stay identical.
- **`pre_llm_call` integration:** new test fires 3 events, runs `pre_llm_call`, asserts returned `context` contains all 3 blocks and buffer is empty afterward.
- **Cron tick callable:** new `sherwood_monitor_cron_tick(subdomain)` tool tested with mocked `sherwood session check` output. Returns structured dict for agent to summarize.
- **Live integration (manual, documented in README):** Spin up Hermes with the plugin, configure a testnet syndicate, trigger a proposal, observe both (a) in-session event injection on next turn AND (b) cron digest delivery to Telegram within 15 min.

## Dependencies + prerequisites

Sherwood CLI:
- `sherwood vault info <sub> --json` must exist and emit `{aumUsd, currentExposureUsd, allowedProtocols, positions: [{protocol, usd}]}`. If absent, a Sherwood CLI PR ships first.

Hermes runtime:
- `cronjob` tool available in the agent's default toolset (documented). Version check at install time; error gracefully if missing.

Plugin dependencies unchanged: Python 3.11+, PyYAML, asyncio.

## Risks

| Risk | Mitigation |
|---|---|
| `ctx.inject_message` works in some Hermes builds and retrofit breaks them | Retrofit keeps `ctx.inject_message` as a fallback if the attribute exists; primary path is `pre_llm_call`. Feature-detects at register time. |
| Cron digests spam the user | Per-run cursor + minimum "new-info" threshold before delivering. First run delivers nothing; subsequent only deltas. |
| `sherwood vault info --json` returns incomplete data | Exposure checks degrade gracefully: `check_concentration` treats missing position data as zero, logs a warning. No false-positive alerts from missing data. |
| Cron re-reads `config.yaml` that user has updated since plugin install | Desired behavior — config is the source of truth, cron picks it up on next tick. |
| Agent ignores `REMEMBER THIS` marker | Skill bundling + explicit instruction in the block text. If the agent still ignores, it's a prompting tuning issue, not a plugin bug. |
| Fresh isolated cron session lacks context about past alerts | Cron cursor file IS that context. Cursor reflects "last interesting event observed" per syndicate, so subsequent ticks only surface new information. |

## Version bump

Plugin goes from `0.1.0` (Phase 1+2) to `0.2.0` (adds features). First GA is still `1.0.0` later.

## Open questions for implementation

- **Cron cadence override.** Should `config.yaml` accept `cron_schedule` (cron expression) so power users can tune the 15-min default? Lean yes, with validation.
- **Exposure concentration threshold.** Fixed 30% default, configurable via `config.yaml`? Yes — same `concentration_threshold_pct` key.
- **Delivery target selection.** Cron jobs inherit their target from Hermes config. The plugin shouldn't override. Documented in README.
