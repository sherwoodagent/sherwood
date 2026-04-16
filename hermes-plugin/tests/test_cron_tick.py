"""Tests for sherwood_monitor.cron_tick."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import sherwood_monitor.cron_tick as cron_tick_mod
from sherwood_monitor.cron_tick import _filter_interesting, cron_tick
from sherwood_monitor.exposure import ConcentrationAlert, ExposureReport

# ---------------------------------------------------------------------------
# Shared fixture helpers
# ---------------------------------------------------------------------------

# A payload with: ProposalCreated (interesting), VoteCast (not interesting),
# RISK_ALERT (interesting), plain MESSAGE (not interesting).
_SAMPLE_PAYLOAD = {
    "events": [
        {"type": "ProposalCreated", "block": 100, "proposalId": "1"},
        {"type": "VoteCast", "block": 101, "voter": "0xabc"},
    ],
    "messages": [
        {
            "type": "RISK_ALERT",
            "sentAt": "2024-01-15T12:00:00Z",
            "content": "high risk",
        },
        {
            "type": "MESSAGE",
            "sentAt": "2024-01-15T12:01:00Z",
            "content": "hello",
        },
    ],
}


def _make_proc(payload: dict, returncode: int = 0):
    """Return a mock subprocess proc whose communicate() yields the encoded payload."""
    proc = MagicMock()
    encoded = json.dumps(payload).encode()
    proc.communicate = AsyncMock(return_value=(encoded, b""))
    proc.returncode = returncode
    proc.wait = AsyncMock(return_value=returncode)
    return proc


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_first_tick_returns_all_interesting(monkeypatch, tmp_path):
    monkeypatch.setattr(cron_tick_mod, "CURSOR_PATH", tmp_path / "cursor.json")

    proc = _make_proc(_SAMPLE_PAYLOAD)
    with patch("asyncio.create_subprocess_exec", return_value=proc):
        result = await cron_tick("sherwood", "alpha-fund")

    events = result["events"]
    # 2 interesting: ProposalCreated (chain) + RISK_ALERT (xmtp)
    assert len(events) == 2
    kinds = {e["kind"] for e in events}
    assert kinds == {"chain", "xmtp"}
    types_ = {e["type"] for e in events}
    assert "ProposalCreated" in types_
    assert "RISK_ALERT" in types_
    # VoteCast and plain MESSAGE must be absent
    assert "VoteCast" not in types_
    assert "MESSAGE" not in types_


@pytest.mark.asyncio
async def test_second_tick_returns_empty_when_no_new(monkeypatch, tmp_path):
    monkeypatch.setattr(cron_tick_mod, "CURSOR_PATH", tmp_path / "cursor.json")

    proc = _make_proc(_SAMPLE_PAYLOAD)
    with patch("asyncio.create_subprocess_exec", return_value=proc):
        first = await cron_tick("sherwood", "alpha-fund")

    assert len(first["events"]) == 2  # sanity

    # Second tick — same payload, cursor already advanced
    proc2 = _make_proc(_SAMPLE_PAYLOAD)
    with patch("asyncio.create_subprocess_exec", return_value=proc2):
        second = await cron_tick("sherwood", "alpha-fund")

    assert second["events"] == []


@pytest.mark.asyncio
async def test_skips_events_before_cursor(monkeypatch, tmp_path):
    monkeypatch.setattr(cron_tick_mod, "CURSOR_PATH", tmp_path / "cursor.json")

    # First tick advances block cursor past 100
    proc1 = _make_proc(_SAMPLE_PAYLOAD)
    with patch("asyncio.create_subprocess_exec", return_value=proc1):
        await cron_tick("sherwood", "alpha-fund")

    # Second tick: a new payload with an event at block 50 (before cursor)
    old_payload = {
        "events": [{"type": "ProposalCreated", "block": 50, "proposalId": "old"}],
        "messages": [],
    }
    proc2 = _make_proc(old_payload)
    with patch("asyncio.create_subprocess_exec", return_value=proc2):
        result = await cron_tick("sherwood", "alpha-fund")

    assert result["events"] == []


@pytest.mark.asyncio
async def test_include_exposure_adds_alerts(monkeypatch, tmp_path):
    monkeypatch.setattr(cron_tick_mod, "CURSOR_PATH", tmp_path / "cursor.json")

    proc = _make_proc({"events": [], "messages": []})
    fake_report = ExposureReport(
        total_aum_usd=100000.0,
        by_protocol={"aerodrome": 40000.0},
        concentration_pct={"aerodrome": 40.0},
        per_syndicate={"alpha-fund": {"aerodrome": 40000.0}},
    )
    fake_alerts = [
        ConcentrationAlert(
            protocol="aerodrome", pct=40.0, syndicates_exposed=["alpha-fund"]
        )
    ]

    with patch("asyncio.create_subprocess_exec", return_value=proc), \
         patch("sherwood_monitor.exposure.aggregate_exposure", AsyncMock(return_value=fake_report)), \
         patch("sherwood_monitor.exposure.check_concentration", return_value=fake_alerts):
        result = await cron_tick(
            "sherwood",
            "alpha-fund",
            include_exposure=True,
            syndicates_for_exposure=["alpha-fund"],
        )

    assert "concentration_alerts" in result
    assert len(result["concentration_alerts"]) == 1
    assert result["concentration_alerts"][0]["protocol"] == "aerodrome"


@pytest.mark.asyncio
async def test_session_check_failure_returns_error(monkeypatch, tmp_path):
    monkeypatch.setattr(cron_tick_mod, "CURSOR_PATH", tmp_path / "cursor.json")

    proc = _make_proc({}, returncode=1)
    with patch("asyncio.create_subprocess_exec", return_value=proc):
        result = await cron_tick("sherwood", "alpha-fund")

    assert result["error"] == "session_check_failed"
    assert result["events"] == []


@pytest.mark.asyncio
async def test_cursor_file_persisted(monkeypatch, tmp_path):
    cursor_file = tmp_path / "cursor.json"
    monkeypatch.setattr(cron_tick_mod, "CURSOR_PATH", cursor_file)

    proc = _make_proc(_SAMPLE_PAYLOAD)
    with patch("asyncio.create_subprocess_exec", return_value=proc):
        await cron_tick("sherwood", "alpha-fund")

    assert cursor_file.exists()
    data = json.loads(cursor_file.read_text())
    assert "alpha-fund" in data
    assert "block" in data["alpha-fund"]
    assert "last_tick_at" in data["alpha-fund"]
