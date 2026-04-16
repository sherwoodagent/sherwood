import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sherwood_monitor.config import Config
from sherwood_monitor.exposure import ExposureReport
from sherwood_monitor.tools import make_handlers

# cron_tick handler tests are below the exposure tests


@pytest.mark.asyncio
async def test_start_handler_returns_pid():
    sup = MagicMock()
    sup.start = AsyncMock(return_value=9999)
    handlers = make_handlers(sup)
    result = await handlers["sherwood_monitor_start"]({"subdomain": "alpha"})
    assert json.loads(result) == {"started": True, "pid": 9999}


@pytest.mark.asyncio
async def test_start_handler_missing_arg():
    sup = MagicMock()
    handlers = make_handlers(sup)
    result = await handlers["sherwood_monitor_start"]({})
    assert "error" in json.loads(result)


@pytest.mark.asyncio
async def test_stop_handler():
    sup = MagicMock()
    sup.stop = AsyncMock()
    handlers = make_handlers(sup)
    result = await handlers["sherwood_monitor_stop"]({"subdomain": "alpha"})
    assert json.loads(result) == {"stopped": True}


@pytest.mark.asyncio
async def test_status_handler():
    sup = MagicMock()
    sup.status = MagicMock(return_value={"syndicates": [{"subdomain": "alpha"}]})
    handlers = make_handlers(sup)
    result = await handlers["sherwood_monitor_status"]({})
    assert json.loads(result)["syndicates"][0]["subdomain"] == "alpha"


@pytest.mark.asyncio
async def test_handler_swallows_exception():
    sup = MagicMock()
    sup.start = AsyncMock(side_effect=RuntimeError("boom"))
    handlers = make_handlers(sup)
    result = await handlers["sherwood_monitor_start"]({"subdomain": "alpha"})
    parsed = json.loads(result)
    assert "error" in parsed
    assert "boom" in parsed["error"]


@pytest.mark.asyncio
async def test_exposure_handler_returns_report():
    sup = MagicMock()
    cfg = Config(sherwood_bin="sherwood", syndicates=["alpha", "beta"], concentration_threshold_pct=30.0)

    fake_report = ExposureReport(
        total_aum_usd=150000.0,
        by_protocol={"moonwell": 40000.0, "aerodrome": 40000.0},
        concentration_pct={"moonwell": 26.67, "aerodrome": 26.67},
        per_syndicate={
            "alpha": {"moonwell": 40000.0, "aerodrome": 20000.0},
            "beta": {"aerodrome": 20000.0},
        },
    )

    with patch("sherwood_monitor.tools.aggregate_exposure", AsyncMock(return_value=fake_report)):
        handlers = make_handlers(sup, cfg)
        result = await handlers["sherwood_monitor_exposure"]({})

    parsed = json.loads(result)
    assert parsed["total_aum_usd"] == 150000.0
    assert parsed["by_protocol"]["moonwell"] == 40000.0
    assert parsed["alerts"] == []  # 26.67 < 30.0 threshold


@pytest.mark.asyncio
async def test_exposure_handler_reports_alerts_over_threshold():
    sup = MagicMock()
    cfg = Config(sherwood_bin="sherwood", syndicates=["alpha", "beta"], concentration_threshold_pct=25.0)

    fake_report = ExposureReport(
        total_aum_usd=150000.0,
        by_protocol={"aerodrome": 40000.0},
        concentration_pct={"aerodrome": 26.67},
        per_syndicate={"alpha": {"aerodrome": 20000.0}, "beta": {"aerodrome": 20000.0}},
    )

    with patch("sherwood_monitor.tools.aggregate_exposure", AsyncMock(return_value=fake_report)):
        handlers = make_handlers(sup, cfg)
        result = await handlers["sherwood_monitor_exposure"]({})

    parsed = json.loads(result)
    assert len(parsed["alerts"]) == 1
    assert parsed["alerts"][0]["protocol"] == "aerodrome"
    assert set(parsed["alerts"][0]["syndicates_exposed"]) == {"alpha", "beta"}


# ---------------------------------------------------------------------------
# cron_tick handler
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cron_tick_handler_returns_events():
    sup = MagicMock()
    cfg = Config(sherwood_bin="sherwood", syndicates=["alpha-fund"], concentration_threshold_pct=30.0)

    fake_result = {
        "subdomain": "alpha-fund",
        "events": [{"kind": "chain", "type": "ProposalCreated", "block": 200}],
        "cursor": {"block": 200, "timestamp": 0.0, "last_tick_at": 9999},
    }

    with patch("sherwood_monitor.tools.cron_tick", AsyncMock(return_value=fake_result)):
        handlers = make_handlers(sup, cfg)
        result = await handlers["sherwood_monitor_cron_tick"]({"subdomain": "alpha-fund"})

    parsed = json.loads(result)
    assert parsed["subdomain"] == "alpha-fund"
    assert len(parsed["events"]) == 1
    assert parsed["events"][0]["type"] == "ProposalCreated"


@pytest.mark.asyncio
async def test_cron_tick_handler_missing_subdomain():
    sup = MagicMock()
    cfg = Config(sherwood_bin="sherwood", syndicates=["alpha-fund"], concentration_threshold_pct=30.0)
    handlers = make_handlers(sup, cfg)
    result = await handlers["sherwood_monitor_cron_tick"]({})
    parsed = json.loads(result)
    assert "error" in parsed
