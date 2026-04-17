"""Fire-and-forget XMTP post helper."""
from __future__ import annotations

import asyncio
import logging

_log = logging.getLogger(__name__)


async def post_summary(sherwood_bin: str, subdomain: str, markdown: str) -> None:
    """Post a markdown summary to the syndicate's XMTP group.

    Runs `sherwood chat <subdomain> send --markdown "<markdown>"`.
    Uses `communicate()` (not `wait()`) to drain both stdout and stderr,
    preventing a pipe-buffer deadlock if the child writes more than the
    OS pipe capacity (~64KB on Linux). All failures are logged and
    swallowed; never raises.
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
        _stdout, stderr = await proc.communicate()
        rc = proc.returncode
        if rc != 0:
            _log.warning(
                "xmtp post failed (rc=%s): %s",
                rc,
                stderr.decode("utf-8", "replace")[:500],
            )
    except Exception as exc:
        _log.warning("xmtp post failed: %s", exc)
