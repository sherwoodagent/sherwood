"""Default state fetcher used by the pre_tool_call risk hook.

Shells out to `sherwood vault info <subdomain> --json`. If the command fails
or returns unexpected output, returns permissive zeros — meaning risk checks
will allow the action (fail-open). A stricter fail-closed mode is a follow-up.
"""
from __future__ import annotations

import asyncio
import json
import logging

_log = logging.getLogger(__name__)


async def fetch_vault_info(sherwood_bin: str, subdomain: str) -> dict | None:
    """Shell out to `sherwood vault info <subdomain> --json` and return the raw dict.

    Returns None on any failure (non-zero exit, parse error, subprocess error).
    Callers are responsible for providing defaults.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            sherwood_bin,
            "vault",
            "info",
            subdomain,
            "--json",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _stderr = await proc.communicate()
        if proc.returncode != 0:
            return None
        return json.loads(stdout.decode("utf-8", "replace") or "{}") or None
    except Exception as exc:
        _log.warning("fetch_vault_info failed for %s: %s", subdomain, exc)
        return None


async def default_state_fetcher(sherwood_bin: str, subdomain: str) -> dict:
    """Thin adapter: calls fetch_vault_info and projects into risk-check shape."""
    defaults = {
        "vault_aum_usd": 0.0,
        "current_exposure_usd": 0.0,
        "allowed_protocols": [],
    }
    payload = await fetch_vault_info(sherwood_bin, subdomain)
    if payload is None:
        return defaults

    try:
        return {
            "vault_aum_usd": float(payload.get("aumUsd", 0)),
            "current_exposure_usd": float(payload.get("currentExposureUsd", 0)),
            "allowed_protocols": list(payload.get("allowedProtocols", [])),
        }
    except (ValueError, TypeError):
        return defaults


def stderr_memory_writer(record: dict) -> None:
    """Day-1 memory writer: log to stderr. Hermes memory provider wiring is follow-up."""
    import sys

    sys.stderr.write(f"[sherwood-monitor memory] {json.dumps(record)}\n")
