"""sherwood-monitor Hermes plugin entry point."""
from __future__ import annotations

import logging
from functools import partial
from pathlib import Path
from typing import Any

from .cli import register_cli
from .config import load_config
from .event_buffer import EventBuffer
from .hooks import (
    make_post_tool_call_hook,
    make_pre_llm_call_hook,
    make_pre_tool_call_hook,
    make_session_hooks,
    on_session_end_factory,
)
from .preflight import run_preflight
from .router import EventRouter
from .schemas import CRON_TICK, EXPOSURE, START, STATUS, STOP
from .state_fetcher import default_state_fetcher, stderr_memory_writer
from .supervisor import Supervisor
from .tools import make_handlers
from .xmtp_post import post_summary

_log = logging.getLogger(__name__)


def _plugin_root() -> Path:
    # Computed lazily so tests can patch Path.home() before calling register().
    return Path.home() / ".hermes" / "plugins" / "sherwood-monitor"


def register(ctx: Any) -> None:
    """Entry point Hermes calls on plugin load."""
    cfg_path = _plugin_root() / "config.yaml"
    cfg = load_config(cfg_path)

    buffer = EventBuffer()

    # Preflight: warn if CLI missing/misconfigured, but continue registering
    pre = run_preflight(cfg.sherwood_bin)
    for warn in pre.warnings:
        buffer.push(f"<sherwood-monitor-warning>\n{warn}\n</sherwood-monitor-warning>")

    router = EventRouter(buffer=buffer, cfg=cfg, post_fn=post_summary)
    supervisor = Supervisor(cfg=cfg, router=router)

    tool_handlers = make_handlers(supervisor, cfg)
    ctx.register_tool(name=START["name"], schema=START, handler=tool_handlers["sherwood_monitor_start"])
    ctx.register_tool(name=STOP["name"], schema=STOP, handler=tool_handlers["sherwood_monitor_stop"])
    ctx.register_tool(name=STATUS["name"], schema=STATUS, handler=tool_handlers["sherwood_monitor_status"])
    ctx.register_tool(name=EXPOSURE["name"], schema=EXPOSURE, handler=tool_handlers["sherwood_monitor_exposure"])
    ctx.register_tool(name=CRON_TICK["name"], schema=CRON_TICK, handler=tool_handlers["sherwood_monitor_cron_tick"])

    session_hooks = make_session_hooks(cfg=cfg, buffer=buffer, supervisor=supervisor)
    ctx.register_hook("on_session_start", session_hooks["on_session_start"])
    ctx.register_hook("on_session_end", on_session_end_factory(supervisor))

    state_fetcher = partial(default_state_fetcher, cfg.sherwood_bin)
    ctx.register_hook("pre_tool_call", make_pre_tool_call_hook(state_fetcher=state_fetcher))
    ctx.register_hook("post_tool_call", make_post_tool_call_hook(memory_writer=stderr_memory_writer, buffer=buffer))
    ctx.register_hook("pre_llm_call", make_pre_llm_call_hook(buffer))

    register_cli(ctx, supervisor)

    skill_path = Path(__file__).parent.parent / "skills" / "sherwood-agent"
    if skill_path.exists():
        ctx.register_skill("sherwood-agent", str(skill_path))
    else:
        _log.warning("skill pack missing at %s — skipping", skill_path)
