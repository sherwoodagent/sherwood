"""LLM-callable tool handlers."""
from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from .config import Config
from .cron_tick import cron_tick
from .exposure import aggregate_exposure, check_concentration
from .supervisor import Supervisor

ToolHandler = Callable[[dict], Awaitable[str]]


def make_handlers(sup: Supervisor, cfg: Config | None = None) -> dict[str, ToolHandler]:
    async def start(args: dict, **_: Any) -> str:
        try:
            sub = args.get("subdomain")
            if not sub:
                return json.dumps({"error": "subdomain required"})
            pid = await sup.start(sub)
            return json.dumps({"started": True, "pid": pid})
        except Exception as exc:
            return json.dumps({"error": str(exc)})

    async def stop(args: dict, **_: Any) -> str:
        try:
            sub = args.get("subdomain")
            if not sub:
                return json.dumps({"error": "subdomain required"})
            await sup.stop(sub)
            return json.dumps({"stopped": True})
        except Exception as exc:
            return json.dumps({"error": str(exc)})

    async def status(args: dict, **_: Any) -> str:
        try:
            return json.dumps(sup.status())
        except Exception as exc:
            return json.dumps({"error": str(exc)})

    async def exposure(args: dict, **_: Any) -> str:
        try:
            _cfg = cfg or Config()
            report = await aggregate_exposure(_cfg.sherwood_bin, _cfg.syndicates)
            alerts = check_concentration(report, _cfg.concentration_threshold_pct)
            return json.dumps({
                "total_aum_usd": report.total_aum_usd,
                "by_protocol": report.by_protocol,
                "concentration_pct": report.concentration_pct,
                "alerts": [
                    {
                        "protocol": a.protocol,
                        "pct": a.pct,
                        "syndicates_exposed": a.syndicates_exposed,
                    }
                    for a in alerts
                ],
            })
        except Exception as exc:
            return json.dumps({"error": str(exc)})

    async def cron_tick_handler(args: dict, **_: Any) -> str:
        try:
            _cfg = cfg or Config()
            sub = args.get("subdomain")
            if not sub:
                return json.dumps({"error": "subdomain required"})
            result = await cron_tick(
                _cfg.sherwood_bin,
                sub,
                include_exposure=args.get("include_exposure", False),
                syndicates_for_exposure=_cfg.syndicates,
                concentration_threshold_pct=_cfg.concentration_threshold_pct,
            )
            return json.dumps(result)
        except Exception as exc:
            return json.dumps({"error": str(exc)})

    return {
        "sherwood_monitor_start": start,
        "sherwood_monitor_stop": stop,
        "sherwood_monitor_status": status,
        "sherwood_monitor_exposure": exposure,
        "sherwood_monitor_cron_tick": cron_tick_handler,
    }
