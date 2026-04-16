"""Hermes lifecycle hooks."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shlex
from typing import Any, Awaitable, Callable

from .config import Config
from .event_buffer import EventBuffer
from .memory import MemoryWriter, build_record
from .risk import ProposeParams, evaluate_propose
from .supervisor import Supervisor

_log = logging.getLogger(__name__)


async def _catchup_one(sherwood_bin: str, subdomain: str) -> dict | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            sherwood_bin,
            "session",
            "check",
            subdomain,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _stderr = await proc.communicate()
        rc = await proc.wait()
        if rc != 0:
            _log.warning("catch-up for %s exited rc=%s", subdomain, rc)
            return None
        return json.loads(stdout.decode("utf-8", "replace") or "{}")
    except Exception as exc:
        _log.warning("catch-up for %s failed: %s", subdomain, exc)
        return None


def _format_catchup_injection(subdomain: str, payload: dict) -> str:
    meta = payload.get("meta", {})
    new_msgs = meta.get("newMessages", 0)
    new_events = meta.get("newEvents", 0)
    return (
        f'<sherwood-catchup syndicate="{subdomain}">\n'
        f"{new_msgs} new messages, {new_events} new events since last check.\n"
        f"{json.dumps(payload, indent=2)}\n"
        f"</sherwood-catchup>"
    )


def make_session_hooks(
    cfg: Config, buffer: EventBuffer, supervisor: Supervisor
) -> dict[str, Callable[[], Awaitable[None]]]:
    async def on_session_start() -> None:
        for sub in cfg.syndicates:
            payload = await _catchup_one(cfg.sherwood_bin, sub)
            if payload is not None:
                buffer.push(_format_catchup_injection(sub, payload))
            if cfg.auto_start:
                try:
                    await supervisor.start(sub)
                except Exception as exc:
                    _log.warning("auto-start failed for %s: %s", sub, exc)

    return {"on_session_start": on_session_start}


def on_session_end_factory(supervisor: Supervisor) -> Callable[[], Awaitable[None]]:
    async def on_session_end() -> None:
        await supervisor.stop_all()

    return on_session_end


def make_pre_llm_call_hook(buffer: EventBuffer) -> Callable[..., Awaitable[dict | None]]:
    async def hook(**_: Any) -> dict | None:
        blocks = buffer.drain()
        if not blocks:
            return None
        return {"context": "\n\n".join(blocks)}

    return hook


# Match `sherwood proposal create <sub>` or `sherwood strategy propose <sub>`
_SHERWOOD_PROPOSE_RE = re.compile(
    r"\bsherwood\s+(?:strategy\s+propose|proposal\s+create)\s+(\S+)"
)
_TERMINAL_TOOLS = {"bash", "terminal", "shell"}

StateFetcher = Callable[[str], Awaitable[dict]]


def _parse_propose_command(command: str) -> tuple[str, float, str] | None:
    """Return (subdomain, size_usd, protocol) or None if not a propose command."""
    m = _SHERWOOD_PROPOSE_RE.search(command)
    if not m:
        return None
    subdomain = m.group(1)

    try:
        tokens = shlex.split(command)
    except ValueError:
        return None

    size_usd = 0.0
    protocol = ""
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok == "--size-usd" and i + 1 < len(tokens):
            try:
                size_usd = float(tokens[i + 1])
            except ValueError:
                pass
            i += 2
            continue
        if tok == "--protocol" and i + 1 < len(tokens):
            protocol = tokens[i + 1]
            i += 2
            continue
        i += 1

    return subdomain, size_usd, protocol


def make_pre_tool_call_hook(state_fetcher: StateFetcher):
    async def hook(tool_name: str = "", params: dict | None = None, **_: Any):
        if tool_name not in _TERMINAL_TOOLS:
            return None
        command = (params or {}).get("command", "")
        parsed = _parse_propose_command(command)
        if parsed is None:
            return None
        subdomain, size_usd, protocol = parsed

        try:
            state = await state_fetcher(subdomain)
        except Exception as exc:
            _log.warning("state fetch failed for %s: %s — allowing", subdomain, exc)
            return None

        verdict = evaluate_propose(
            ProposeParams(
                subdomain=subdomain,
                proposed_size_usd=size_usd,
                current_exposure_usd=float(state.get("current_exposure_usd", 0)),
                vault_aum_usd=float(state.get("vault_aum_usd", 0)),
                protocol=protocol,
                allowed_protocols=list(state.get("allowed_protocols", [])),
            )
        )
        if not verdict.ok:
            return {"blocked": True, "reason": verdict.reason}
        return None

    return hook


_SHERWOOD_SETTLE_RE = re.compile(
    r"\bsherwood\s+proposal\s+(execute|settle)\s+(\S+)"
)


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


def make_post_tool_call_hook(memory_writer: MemoryWriter, buffer: EventBuffer):
    async def hook(
        tool_name: str = "",
        params: dict | None = None,
        result: Any = None,
        **_: Any,
    ):
        if tool_name not in _TERMINAL_TOOLS:
            return None
        command = (params or {}).get("command", "")
        m = _SHERWOOD_SETTLE_RE.search(command)
        if not m:
            return None
        action = m.group(1)
        subdomain = m.group(2)
        result_str = result if isinstance(result, str) else json.dumps(result)
        record = build_record(
            subdomain=subdomain,
            action=action,
            command=command,
            result_json=result_str,
        )
        try:
            memory_writer(record)
        except Exception:
            pass
        try:
            buffer.push(_format_settlement_block(record))
        except Exception:
            pass
        return None

    return hook
