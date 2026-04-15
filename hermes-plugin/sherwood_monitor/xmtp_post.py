"""Fire-and-forget XMTP post helper."""
from __future__ import annotations

import asyncio
import logging

_log = logging.getLogger(__name__)


async def post_summary(sherwood_bin: str, subdomain: str, markdown: str) -> None:
    """Post a markdown summary to the syndicate's XMTP group.

    Runs `sherwood chat <subdomain> send --markdown "<markdown>"`.
    All failures are logged and swallowed; never raises.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            sherwood_bin,
            "chat",
            subdomain,
            "send",
            "--markdown",
            markdown,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        rc = await proc.wait()
        if rc != 0:
            try:
                _, stderr = await proc.communicate()
                _log.warning("xmtp post failed (rc=%s): %s", rc, stderr.decode("utf-8", "replace")[:500])
            except Exception:
                _log.warning("xmtp post failed (rc=%s)", rc)
    except Exception as exc:
        _log.warning("xmtp post failed: %s", exc)
