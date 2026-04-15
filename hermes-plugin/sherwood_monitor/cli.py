"""`hermes sherwood <cmd>` CLI commands."""
from __future__ import annotations

import asyncio
import json
from typing import Any

from .supervisor import Supervisor


def register_cli(ctx: Any, sup: Supervisor) -> None:
    """Register `hermes sherwood start|stop|status|tail` commands."""

    def _setup_common(parser: Any) -> None:
        parser.add_argument("subdomain", nargs="?")

    def start_handler(args: Any) -> int:
        if not args.subdomain:
            print("subdomain required", flush=True)
            return 2
        pid = asyncio.run(sup.start(args.subdomain))
        print(json.dumps({"started": True, "pid": pid}))
        return 0

    def stop_handler(args: Any) -> int:
        if not args.subdomain:
            print("subdomain required", flush=True)
            return 2
        asyncio.run(sup.stop(args.subdomain))
        print(json.dumps({"stopped": True}))
        return 0

    def status_handler(_args: Any) -> int:
        print(json.dumps(sup.status(), indent=2))
        return 0

    def tail_handler(args: Any) -> int:
        if not args.subdomain:
            print("subdomain required", flush=True)
            return 2
        lines = sup.stderr_tail(args.subdomain)
        for line in lines:
            print(line)
        return 0

    ctx.register_cli_command(
        name="start", help="start monitoring a syndicate", setup_fn=_setup_common, handler_fn=start_handler
    )
    ctx.register_cli_command(
        name="stop", help="stop monitoring a syndicate", setup_fn=_setup_common, handler_fn=stop_handler
    )
    ctx.register_cli_command(
        name="status", help="show monitor status", setup_fn=lambda p: None, handler_fn=status_handler
    )
    ctx.register_cli_command(
        name="tail", help="tail stderr of a monitor", setup_fn=_setup_common, handler_fn=tail_handler
    )
