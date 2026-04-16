# Hermes Plugin Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan batch-by-batch. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `sherwood-monitor` with autonomous cron-based monitoring, cross-syndicate exposure tracking, settlement memory surfacing, and retrofit the injection path to use the documented `pre_llm_call` hook.

**Spec:** [docs/superpowers/specs/2026-04-16-hermes-plugin-phase-3-design.md](../specs/2026-04-16-hermes-plugin-phase-3-design.md)

**Lands on top of:** the Phase 1+2 code shipped in PR #224 (branch `feat/hermes-plugin-design`). All 80 existing tests must keep passing.

---

## Key architectural decision (read before anything)

**Drop `ctx.inject_message` entirely.** Phase 1+2 called `ctx.inject_message(content=..., role="user")` — this API is not in the current Hermes plugin guide. Phase 3 replaces it with:

1. An `EventBuffer` (thread-safe `deque`) owned by the plugin module.
2. Handlers call `buffer.push(block)` instead of `ctx.inject_message(...)`.
3. A `pre_llm_call` hook drains the buffer and returns `{"context": "\n\n".join(blocks)}`.

Handler signatures change from `(subdomain, rec, ctx, cfg, post_fn)` to `(subdomain, rec, buffer, cfg, post_fn)`. Router drops `ctx` — it only needs buffer + cfg + post_fn.

Existing tests for handlers/router/hooks need to update mocks: instead of asserting `ctx.inject_message.assert_called_once()`, assert `buffer.push.assert_called_once()` (buffer is mocked as `MagicMock(spec=EventBuffer)`).

---

## Batch A — Retrofit: EventBuffer + pre_llm_call

**Goal:** Replace all `ctx.inject_message` calls with `EventBuffer.push` + `pre_llm_call` context injection. No behavioral change visible to the agent; internals now match Hermes' documented API.

### Files touched

- Create: `sherwood_monitor/event_buffer.py`
- Create: `tests/test_event_buffer.py`
- Modify: `sherwood_monitor/handlers.py` (signature change, drop ctx)
- Modify: `sherwood_monitor/router.py` (signature change, drop ctx)
- Modify: `sherwood_monitor/hooks.py` (session hooks push to buffer; add `make_pre_llm_call_hook`)
- Modify: `sherwood_monitor/__init__.py` (wire buffer, register pre_llm_call)
- Modify: `tests/test_handlers.py` (buffer mock instead of ctx.inject_message)
- Modify: `tests/test_router.py`
- Modify: `tests/test_hooks.py`
- Modify: `tests/test_register.py`

### Step 1 — Write `event_buffer.py` + test

`sherwood_monitor/event_buffer.py`:
```python
"""Thread-safe ring buffer of <sherwood-event> blocks to inject into the LLM's next turn."""
from __future__ import annotations

import threading
from collections import deque
from typing import Iterable

DEFAULT_MAX = 200


class EventBuffer:
    def __init__(self, maxlen: int = DEFAULT_MAX) -> None:
        self._q: deque[str] = deque(maxlen=maxlen)
        self._lock = threading.Lock()

    def push(self, block: str) -> None:
        with self._lock:
            self._q.append(block)

    def drain(self) -> list[str]:
        with self._lock:
            items = list(self._q)
            self._q.clear()
            return items

    def __len__(self) -> int:
        with self._lock:
            return len(self._q)
```

`tests/test_event_buffer.py`:
```python
import threading
from sherwood_monitor.event_buffer import EventBuffer


def test_push_and_drain():
    b = EventBuffer()
    b.push("a")
    b.push("b")
    assert b.drain() == ["a", "b"]
    assert b.drain() == []


def test_bounded_capacity():
    b = EventBuffer(maxlen=2)
    b.push("a"); b.push("b"); b.push("c")
    assert b.drain() == ["b", "c"]


def test_thread_safety():
    b = EventBuffer()
    def pusher():
        for i in range(100):
            b.push(str(i))
    threads = [threading.Thread(target=pusher) for _ in range(5)]
    for t in threads: t.start()
    for t in threads: t.join()
    assert len(b.drain()) == 500
```

Commit: `feat(hermes-plugin): EventBuffer for pre_llm_call injection`

### Step 2 — Retrofit handlers

In `sherwood_monitor/handlers.py`, change every function signature from `(subdomain, rec, ctx, cfg, post_fn)` to `(subdomain, rec, buffer, cfg, post_fn)`. Replace every `ctx.inject_message(content=X, role="user")` call with `buffer.push(X)`.

Keep `PostFn` type alias.

### Step 3 — Retrofit router

`sherwood_monitor/router.py`:
```python
"""EventRouter: decode a raw record and dispatch to the right handler."""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from typing import Any

from .config import Config
from .event_buffer import EventBuffer
from .handlers import PostFn, handle_chain_event, handle_xmtp_message
from .models import ChainEvent, SessionMessage, decode_record

_log = logging.getLogger(__name__)


class EventRouter:
    def __init__(self, buffer: EventBuffer, cfg: Config, post_fn: PostFn) -> None:
        self._buffer = buffer
        self._cfg = cfg
        self._post_fn = post_fn
        self._events_seen: dict[str, int] = defaultdict(int)
        self._last_event_at: dict[str, float] = {}

    async def route(self, subdomain: str, raw: Any) -> None:
        try:
            rec = decode_record(raw)
        except ValueError as exc:
            _log.warning("decode error on %s: %s", subdomain, exc)
            return

        self._events_seen[subdomain] += 1
        self._last_event_at[subdomain] = time.time()

        try:
            if isinstance(rec, ChainEvent):
                await handle_chain_event(subdomain, rec, self._buffer, self._cfg, self._post_fn)
            elif isinstance(rec, SessionMessage):
                await handle_xmtp_message(subdomain, rec, self._buffer, self._cfg, self._post_fn)
        except Exception as exc:
            _log.exception("handler error on %s: %s", subdomain, exc)

    def events_seen(self, subdomain: str) -> int:
        return self._events_seen.get(subdomain, 0)

    def last_event_at(self, subdomain: str) -> float | None:
        return self._last_event_at.get(subdomain)
```

### Step 4 — Retrofit hooks

In `sherwood_monitor/hooks.py`:

- `make_session_hooks` now takes `buffer: EventBuffer` (instead of `ctx`). The catch-up injection pushes to buffer:
  ```python
  buffer.push(_format_catchup_injection(sub, payload))
  ```
- Add new factory:
  ```python
  def make_pre_llm_call_hook(buffer: EventBuffer):
      async def hook(**_: Any):
          blocks = buffer.drain()
          if not blocks:
              return None
          return {"context": "\n\n".join(blocks)}
      return hook
  ```

### Step 5 — Update `__init__.py`

Import `EventBuffer` and `make_pre_llm_call_hook`. In `register(ctx)`:
```python
buffer = EventBuffer()
router = EventRouter(buffer=buffer, cfg=cfg, post_fn=post_summary)
supervisor = Supervisor(cfg=cfg, router=router)
# ... existing tool registration ...
session_hooks = make_session_hooks(cfg=cfg, buffer=buffer, supervisor=supervisor)
ctx.register_hook("on_session_start", session_hooks["on_session_start"])
ctx.register_hook("on_session_end", on_session_end_factory(supervisor))
ctx.register_hook("pre_llm_call", make_pre_llm_call_hook(buffer))
```

### Step 6 — Update existing tests

Across `test_handlers.py`, `test_router.py`, `test_hooks.py`, `test_register.py`:

- Replace `ctx = MagicMock()` + `ctx.inject_message.assert_called_once()` pattern with `buffer = MagicMock()` + `buffer.push.assert_called_once()`.
- Handler test helpers: pass `buffer` positional arg where `ctx` was.
- In `test_register.py`, add `ctx.register_hook.call_count == 5` (4 previous hooks + new `pre_llm_call`).

### Step 7 — Add explicit pre_llm_call integration test

New test in `tests/test_hooks.py`:
```python
import pytest
from sherwood_monitor.event_buffer import EventBuffer
from sherwood_monitor.hooks import make_pre_llm_call_hook


@pytest.mark.asyncio
async def test_pre_llm_call_drains_buffer_and_returns_context():
    buf = EventBuffer()
    buf.push("<a>1</a>")
    buf.push("<b>2</b>")
    hook = make_pre_llm_call_hook(buf)
    result = await hook(session_id="s1", user_message="hi")
    assert result == {"context": "<a>1</a>\n\n<b>2</b>"}
    assert len(buf) == 0


@pytest.mark.asyncio
async def test_pre_llm_call_returns_none_when_empty():
    hook = make_pre_llm_call_hook(EventBuffer())
    result = await hook(session_id="s1")
    assert result is None
```

### Commit strategy

3 commits for Batch A:
1. `feat(hermes-plugin): EventBuffer thread-safe ring buffer`
2. `refactor(hermes-plugin): retrofit handlers/router/hooks to use EventBuffer`
3. `feat(hermes-plugin): pre_llm_call hook drains EventBuffer into context`

Final test target: 80 + 3 (event_buffer) + 2 (pre_llm_call) = **85 tests**

---

## Batch B — Cross-syndicate exposure

**Files:**
- Create: `sherwood_monitor/exposure.py`
- Create: `tests/test_exposure.py`
- Create: `fixtures/vault_info_alpha.json`, `fixtures/vault_info_beta.json`
- Modify: `sherwood_monitor/schemas.py` (add EXPOSURE schema)
- Modify: `sherwood_monitor/tools.py` (add `sherwood_monitor_exposure` handler)
- Modify: `sherwood_monitor/__init__.py` (register new tool)
- Modify: `sherwood_monitor/state_fetcher.py` (extract shared `parse_vault_info`)
- Modify: `tests/test_register.py` (bump tool count 3 → 4)

### `exposure.py`

```python
"""Cross-syndicate exposure aggregation and concentration alerts."""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from .state_fetcher import fetch_vault_info

_log = logging.getLogger(__name__)

DEFAULT_CONCENTRATION_PCT = 30.0


@dataclass(frozen=True)
class ExposureReport:
    total_aum_usd: float
    by_protocol: dict[str, float]
    concentration_pct: dict[str, float]
    per_syndicate: dict[str, dict[str, float]] = field(default_factory=dict)


@dataclass(frozen=True)
class ConcentrationAlert:
    protocol: str
    pct: float
    syndicates_exposed: list[str]


async def aggregate_exposure(
    sherwood_bin: str, syndicates: list[str]
) -> ExposureReport:
    total_aum = 0.0
    by_protocol: dict[str, float] = {}
    per_syndicate: dict[str, dict[str, float]] = {}

    results = await asyncio.gather(
        *(fetch_vault_info(sherwood_bin, s) for s in syndicates),
        return_exceptions=True,
    )
    for sub, info in zip(syndicates, results):
        if isinstance(info, Exception) or not info:
            _log.warning("exposure: skipping %s (%s)", sub, info)
            continue
        total_aum += float(info.get("aumUsd", 0))
        positions = info.get("positions", []) or []
        per = per_syndicate.setdefault(sub, {})
        for p in positions:
            proto = str(p.get("protocol", "")).lower()
            if not proto:
                continue
            usd = float(p.get("usd", 0))
            by_protocol[proto] = by_protocol.get(proto, 0.0) + usd
            per[proto] = per.get(proto, 0.0) + usd

    concentration = {}
    if total_aum > 0:
        for proto, usd in by_protocol.items():
            concentration[proto] = round(usd / total_aum * 100, 2)

    return ExposureReport(
        total_aum_usd=total_aum,
        by_protocol=by_protocol,
        concentration_pct=concentration,
        per_syndicate=per_syndicate,
    )


def check_concentration(
    report: ExposureReport, threshold_pct: float = DEFAULT_CONCENTRATION_PCT
) -> list[ConcentrationAlert]:
    alerts: list[ConcentrationAlert] = []
    for proto, pct in report.concentration_pct.items():
        if pct >= threshold_pct:
            exposed = [sub for sub, per in report.per_syndicate.items() if proto in per]
            alerts.append(
                ConcentrationAlert(protocol=proto, pct=pct, syndicates_exposed=exposed)
            )
    return alerts
```

### `state_fetcher.py` changes

Extract the `sherwood vault info --json` shell-out into a new `fetch_vault_info(sherwood_bin, subdomain) -> dict | None` coroutine. `default_state_fetcher` becomes a thin adapter that projects the dict into the risk-check shape. `exposure.aggregate_exposure` consumes the full dict directly.

### Tests

`tests/test_exposure.py`:
- `test_aggregate_exposure_sums_across_syndicates`: mock `fetch_vault_info` returns dict with `positions: [{protocol: "moonwell", usd: 50000}, ...]`. Assert `by_protocol` sums correctly.
- `test_aggregate_exposure_skips_failed_vaults`: `fetch_vault_info` raises for one syndicate; aggregation continues with others.
- `test_concentration_pct_correct`: `total_aum=100000`, `aerodrome=40000` → `concentration_pct == {"aerodrome": 40.0}`.
- `test_check_concentration_flags_over_threshold`.
- `test_check_concentration_empty_when_all_under`.

### Tool schema + handler

Add to `schemas.py`:
```python
EXPOSURE = {
    "name": "sherwood_monitor_exposure",
    "description": (
        "Aggregate exposure across all configured syndicates. Returns total "
        "AUM, per-protocol breakdown, concentration percentages, and any "
        "concentration alerts above the configured threshold. Use this to "
        "answer questions like 'what's my total Aerodrome exposure?' or "
        "'which protocols am I over-exposed to?'"
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}
```

Add to `tools.py` inside `make_handlers(sup, cfg)` — note cfg now needed:
```python
async def exposure(args: dict, **_: Any) -> str:
    try:
        report = await aggregate_exposure(cfg.sherwood_bin, cfg.syndicates)
        alerts = check_concentration(report, cfg.concentration_threshold_pct)
        return json.dumps({
            "total_aum_usd": report.total_aum_usd,
            "by_protocol": report.by_protocol,
            "concentration_pct": report.concentration_pct,
            "alerts": [
                {"protocol": a.protocol, "pct": a.pct, "syndicates_exposed": a.syndicates_exposed}
                for a in alerts
            ],
        })
    except Exception as exc:
        return json.dumps({"error": str(exc)})
```

Add `concentration_threshold_pct: float = 30.0` to `Config`.

### Commit

`feat(hermes-plugin): cross-syndicate exposure aggregation + tool`

Test target after Batch B: 85 + 5 = **90 tests**

---

## Batch C — Autonomous cron tick

**Files:**
- Create: `sherwood_monitor/cron_tick.py`
- Create: `tests/test_cron_tick.py`
- Modify: `sherwood_monitor/schemas.py` (add CRON_TICK)
- Modify: `sherwood_monitor/tools.py` (add handler)
- Modify: `sherwood_monitor/__init__.py` (register tool)
- Modify: `tests/test_register.py` (tool count → 5)
- Modify: `BOOT.md` (add cron setup instruction)

### `cron_tick.py`

```python
"""One-shot autonomous tick: catch interesting events + concentration alerts per syndicate."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

_log = logging.getLogger(__name__)

CURSOR_PATH = Path.home() / ".hermes" / "plugins" / "sherwood-monitor" / "cron_cursor.json"

INTERESTING_CHAIN = {
    "ProposalCreated",
    "ProposalSettled",
    "ProposalCancelled",
    "ProposalExecuted",
}
INTERESTING_XMTP = {"RISK_ALERT", "APPROVAL_REQUEST"}


def _load_cursors() -> dict:
    try:
        return json.loads(CURSOR_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_cursors(cursors: dict) -> None:
    CURSOR_PATH.parent.mkdir(parents=True, exist_ok=True)
    CURSOR_PATH.write_text(json.dumps(cursors, indent=2))


async def _run_session_check(sherwood_bin: str, subdomain: str) -> dict | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            sherwood_bin, "session", "check", subdomain,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        rc = await proc.wait() if proc.returncode is None else proc.returncode
        if rc != 0:
            _log.warning("session check for %s rc=%s", subdomain, rc)
            return None
        return json.loads(stdout.decode("utf-8", "replace") or "{}")
    except Exception as exc:
        _log.warning("session check failed for %s: %s", subdomain, exc)
        return None


def _filter_interesting(
    payload: dict, block_cursor: int, ts_cursor: float
) -> tuple[list[dict], int, float]:
    new_events = []
    max_block = block_cursor
    max_ts = ts_cursor

    for ev in payload.get("events", []):
        block = int(ev.get("block", 0))
        if block <= block_cursor:
            continue
        if ev.get("type") in INTERESTING_CHAIN:
            new_events.append({"kind": "chain", **ev})
        if block > max_block:
            max_block = block

    for msg in payload.get("messages", []):
        sent = msg.get("sentAt", "")
        try:
            import datetime as _dt
            ts = _dt.datetime.fromisoformat(sent.replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        if ts <= ts_cursor:
            continue
        if msg.get("type") in INTERESTING_XMTP:
            new_events.append({"kind": "xmtp", **msg})
        if ts > max_ts:
            max_ts = ts

    return new_events, max_block, max_ts


async def cron_tick(
    sherwood_bin: str,
    subdomain: str,
    *,
    include_exposure: bool = False,
    syndicates_for_exposure: list[str] | None = None,
    concentration_threshold_pct: float = 30.0,
) -> dict:
    cursors = _load_cursors()
    sub_cursor = cursors.get(subdomain, {"block": 0, "timestamp": 0.0})

    payload = await _run_session_check(sherwood_bin, subdomain)
    if payload is None:
        return {"subdomain": subdomain, "error": "session_check_failed", "events": []}

    new_events, max_block, max_ts = _filter_interesting(
        payload, int(sub_cursor.get("block", 0)), float(sub_cursor.get("timestamp", 0))
    )

    cursors[subdomain] = {
        "block": max_block,
        "timestamp": max_ts,
        "last_tick_at": int(time.time()),
    }
    _save_cursors(cursors)

    result: dict[str, Any] = {
        "subdomain": subdomain,
        "events": new_events,
        "cursor": cursors[subdomain],
    }

    if include_exposure and syndicates_for_exposure:
        from .exposure import aggregate_exposure, check_concentration
        report = await aggregate_exposure(sherwood_bin, syndicates_for_exposure)
        alerts = check_concentration(report, concentration_threshold_pct)
        result["concentration_alerts"] = [
            {"protocol": a.protocol, "pct": a.pct, "syndicates": a.syndicates_exposed}
            for a in alerts
        ]

    return result
```

### Tool schema + handler

`schemas.py` add:
```python
CRON_TICK = {
    "name": "sherwood_monitor_cron_tick",
    "description": (
        "Autonomous tick: catch new interesting events for a syndicate since "
        "the last tick (ProposalCreated/Settled/Cancelled/Executed, RISK_ALERT, "
        "APPROVAL_REQUEST). Updates the tick cursor. Pass include_exposure=true "
        "to also compute concentration alerts. Used by the plugin's cron job to "
        "deliver digests via Hermes' gateway (Telegram/Discord). Returns empty "
        "events list when nothing interesting happened — that's the normal case."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "subdomain": {"type": "string"},
            "include_exposure": {"type": "boolean", "default": False},
        },
        "required": ["subdomain"],
    },
}
```

Handler calls `cron_tick(...)` with `cfg.sherwood_bin`, `cfg.syndicates`, `cfg.concentration_threshold_pct`. Returns JSON-stringified result.

### Tests (`tests/test_cron_tick.py`)

Mock `asyncio.create_subprocess_exec` to return a proc whose `communicate()` returns `(payload.encode(), b"")`. Test:
- First tick returns all interesting events, skips non-interesting.
- Second tick with same payload returns empty list (cursor advanced).
- Skips events before cursor.
- `include_exposure=True` adds `concentration_alerts` key.
- Cursor file written correctly.
- Handles session-check failure gracefully.

Use `monkeypatch` on `CURSOR_PATH` to point at tmp_path.

### BOOT.md updates

Append to `BOOT.md`:
```markdown
## Cron setup (one-time)

If no `sherwood-monitor` cron is registered:
1. Call `cronjob(action="list")` to check.
2. If absent, call:
   cronjob(
     action="create",
     prompt="For each syndicate in ~/.hermes/plugins/sherwood-monitor/config.yaml, call sherwood_monitor_cron_tick(subdomain, include_exposure=true). Compose a concise digest of any returned events and concentration alerts. If all ticks returned empty events and no alerts, say nothing (deliver no message). Otherwise deliver the digest.",
     schedule="*/15 * * * *",
     name="sherwood-monitor"
   )
```

### Commit

`feat(hermes-plugin): autonomous cron tick tool + digest delivery`

Test target: 90 + 6 = **96 tests**

---

## Batch D — Settlement memory surfacing + docs + version bump

**Files:**
- Create: `skills/sherwood-agent/skills/remember-settlement/SKILL.md`
- Modify: `sherwood_monitor/hooks.py` (post_tool_call now pushes to buffer)
- Modify: `tests/test_hooks.py` (assert buffer push on settle)
- Modify: `README.md`
- Modify: `pyproject.toml` (version 0.1.0 → 0.2.0)
- Modify: `plugin.yaml` (version 0.1.0 → 0.2.0)

### `remember-settlement` skill

Create `skills/sherwood-agent/skills/remember-settlement/SKILL.md`:
```markdown
---
name: remember-settlement
description: Use immediately after observing any <sherwood-settlement> injection block. Persists institutional knowledge about strategy performance to agent memory.
---

# Remember settlement

When you see a `<sherwood-settlement>` block in the injected context, capture it in memory so you can reason about strategy performance over time.

## What to capture

From the block, extract: syndicate, strategy name, pnl_usd, duration_days, proposer, date.

## How to capture

Call the `memory` tool:

```
memory(
    action="add",
    content="Syndicate <sub> — strategy '<name>' settled <pnl_usd> over <duration_days>d on <date>. Proposer: <proposer>."
)
```

## When to skip

- The same settlement is already in memory (check with substring match on syndicate + strategy name + date).
- Memory is full — consolidate first via `memory(action="replace", ...)`.

## Why

Memory entries like these let you answer questions weeks later:
- "Has the Aerodrome LP strategy been profitable?"
- "What's the average P&L on 7-day strategies for alpha-fund?"
- "Which proposer has the best track record?"
```

### `hooks.py` — enhance post_tool_call

Update `make_post_tool_call_hook` to accept `buffer: EventBuffer` as well. On a matching settle/execute command, in addition to calling the memory_writer, push a `<sherwood-settlement>` block:

```python
def make_post_tool_call_hook(memory_writer, buffer: EventBuffer):
    async def hook(tool_name="", params=None, result=None, **_):
        # ... existing command-match logic ...
        record = build_record(...)
        write_settlement(memory_writer, ...)
        # New: also push a block to the buffer for the agent's next turn
        block = _format_settlement_block(record)
        buffer.push(block)
    return hook


def _format_settlement_block(record: dict) -> str:
    return (
        f'<sherwood-settlement syndicate="{record["syndicate"]}" '
        f'action="{record["action"]}" '
        f'proposal_id="{record.get("proposal_id", "?")}" '
        f'pnl_usd="{record.get("pnl_usd", "n/a")}" '
        f'tx="{record.get("tx_hash", "?")}">\n'
        f"REMEMBER THIS — use the remember-settlement skill to persist it to memory.\n"
        f"</sherwood-settlement>"
    )
```

Update `__init__.py` to pass buffer into `make_post_tool_call_hook`.

Update `tests/test_hooks.py` post_tool_call tests: assert `buffer.push.called` on settle/execute; assert `buffer.push.not_called` on other commands.

### README additions

Add sections:
- **Autonomous mode**: explain the cron tick, 15-min cadence, delivery via gateway.
- **Cross-syndicate exposure**: how to use `sherwood_monitor_exposure()`, concentration threshold config.
- **Settlement memory**: how the agent learns from settlements over time.
- Expand the event routing table to mention `<sherwood-settlement>` blocks.

### Version bump

- `pyproject.toml`: `version = "0.2.0"`
- `plugin.yaml`: `version: "0.2.0"`

### Commits

1. `feat(hermes-plugin): remember-settlement skill + buffer push on settle/execute`
2. `docs(hermes-plugin): README covers autonomous mode, exposure, memory`
3. `chore(hermes-plugin): bump to 0.2.0`

Final test target: **96 tests passing**

---

## Verification checklist

- [ ] All 96 tests pass
- [ ] `python -c "from sherwood_monitor import register; print('ok')"` succeeds
- [ ] `grep -r "inject_message" sherwood_monitor/` returns nothing (retrofit complete)
- [ ] `pyproject.toml` and `plugin.yaml` both show `0.2.0`
- [ ] README has sections on autonomous mode, exposure, settlement memory
- [ ] `BOOT.md` has the cron setup instruction
- [ ] `skills/sherwood-agent/skills/remember-settlement/SKILL.md` exists
- [ ] Push to `origin/feat/hermes-plugin-design`; PR #224 updates automatically
- [ ] Update PR description to reflect Phase 3 scope
