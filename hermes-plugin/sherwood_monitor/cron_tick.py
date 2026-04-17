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
    """Filter a session-check payload for interesting events past the cursor.

    Cursor-advance rules (safety-critical):
    - Events are sorted ascending by block before iteration. The Sherwood CLI
      already returns them sorted (see `events.sort((a, b) => a.block - b.block)`
      in cli/src/commands/session.ts), but we sort defensively in case of
      future RPC pagination / reorg quirks that could deliver them out of order.
    - We advance the block cursor to the max block OBSERVED (interesting or
      not), which prevents re-scanning the same window every tick. The
      ordering guarantee above ensures an interesting event at block N+1 is
      processed before any uninteresting event at block N+2 causes the cursor
      to skip past it.
    - Same-block ordering within a transaction is not disambiguated here. If
      multiple events share the same block and one is interesting, the CLI
      must return them in stable order; the cursor advance is strict greater
      than comparison, so repeats at block N are processed only if block_cursor
      is < N.
    - Messages use `sentAt` ISO timestamps sorted ascending for the same reason.
    """
    new_events: list[dict] = []
    max_block = block_cursor
    max_ts = ts_cursor

    events_sorted = sorted(
        payload.get("events", []), key=lambda e: int(e.get("block", 0))
    )
    for ev in events_sorted:
        block = int(ev.get("block", 0))
        if block <= block_cursor:
            continue
        if ev.get("type") in INTERESTING_CHAIN:
            new_events.append({"kind": "chain", **ev})
        if block > max_block:
            max_block = block

    import datetime as _dt

    msgs_with_ts: list[tuple[float, dict]] = []
    for msg in payload.get("messages", []):
        sent = msg.get("sentAt", "")
        try:
            ts = _dt.datetime.fromisoformat(sent.replace("Z", "+00:00")).timestamp()
        except ValueError:
            continue
        msgs_with_ts.append((ts, msg))
    msgs_with_ts.sort(key=lambda t: t[0])

    for ts, msg in msgs_with_ts:
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
