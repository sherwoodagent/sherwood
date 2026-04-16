"""Shared pytest fixtures."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures"


def load_fixture(name: str) -> dict:
    """Load a JSON fixture by filename (without .json)."""
    return json.loads((FIXTURES_DIR / f"{name}.json").read_text())


@pytest.fixture
def fixture():
    """Factory fixture for loading test fixtures by name."""
    return load_fixture


@pytest.fixture
def mock_ctx():
    """Mock Hermes plugin context with common methods."""
    ctx = MagicMock()
    ctx.register_tool = MagicMock()
    ctx.register_hook = MagicMock()
    ctx.register_cli_command = MagicMock()
    ctx.register_skill = MagicMock()
    return ctx
