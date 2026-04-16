"""Tests for cross-syndicate exposure aggregation and concentration alerts."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from sherwood_monitor.exposure import (
    ConcentrationAlert,
    ExposureReport,
    aggregate_exposure,
    check_concentration,
)

FIXTURES = Path(__file__).parent.parent / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


ALPHA = _load("vault_info_alpha.json")
BETA = _load("vault_info_beta.json")


@pytest.mark.asyncio
async def test_aggregate_exposure_sums_across_syndicates():
    with patch(
        "sherwood_monitor.exposure.fetch_vault_info",
        side_effect=[ALPHA, BETA],
    ):
        report = await aggregate_exposure("sherwood", ["alpha", "beta"])

    assert report.by_protocol == {"moonwell": 40000.0, "aerodrome": 40000.0}
    assert report.total_aum_usd == 150000.0


@pytest.mark.asyncio
async def test_aggregate_exposure_skips_failed_vaults():
    with patch(
        "sherwood_monitor.exposure.fetch_vault_info",
        side_effect=[RuntimeError("connection refused"), BETA],
    ):
        report = await aggregate_exposure("sherwood", ["alpha", "beta"])

    # alpha skipped — only beta counted
    assert report.by_protocol == {"aerodrome": 20000.0}
    assert report.total_aum_usd == 50000.0
    assert "alpha" not in report.per_syndicate
    assert "beta" in report.per_syndicate


def test_concentration_pct_correct():
    report = ExposureReport(
        total_aum_usd=150000.0,
        by_protocol={"moonwell": 40000.0, "aerodrome": 40000.0},
        concentration_pct={
            "moonwell": round(40000 / 150000 * 100, 2),
            "aerodrome": round(40000 / 150000 * 100, 2),
        },
        per_syndicate={
            "alpha": {"moonwell": 40000.0, "aerodrome": 20000.0},
            "beta": {"aerodrome": 20000.0},
        },
    )
    # aerodrome: 40000 / 150000 = 26.666... → 26.67
    assert report.concentration_pct["aerodrome"] == 26.67


def test_check_concentration_flags_over_threshold():
    report = ExposureReport(
        total_aum_usd=150000.0,
        by_protocol={"moonwell": 40000.0, "aerodrome": 40000.0},
        concentration_pct={"moonwell": 26.67, "aerodrome": 26.67},
        per_syndicate={
            "alpha": {"moonwell": 40000.0, "aerodrome": 20000.0},
            "beta": {"aerodrome": 20000.0},
        },
    )
    # threshold of 25 → both protocols exceed it
    alerts = check_concentration(report, threshold_pct=25.0)
    assert len(alerts) == 2
    aero_alert = next(a for a in alerts if a.protocol == "aerodrome")
    assert set(aero_alert.syndicates_exposed) == {"alpha", "beta"}


def test_check_concentration_empty_when_all_under():
    report = ExposureReport(
        total_aum_usd=150000.0,
        by_protocol={"moonwell": 40000.0, "aerodrome": 40000.0},
        concentration_pct={"moonwell": 26.67, "aerodrome": 26.67},
        per_syndicate={
            "alpha": {"moonwell": 40000.0, "aerodrome": 20000.0},
            "beta": {"aerodrome": 20000.0},
        },
    )
    # threshold of 30 → nothing exceeds it (26.67 < 30)
    alerts = check_concentration(report, threshold_pct=30.0)
    assert alerts == []
