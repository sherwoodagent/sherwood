# Hermes Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a complete, out-of-the-box Hermes plugin (`sherwood-monitor`) that bridges Sherwood's on-chain + XMTP event stream into Hermes' plugin/hook system, injecting events into the agent conversation and auto-posting summaries back to the syndicate's XMTP group.

**Architecture:** Single Python module running inside the Hermes process. Supervisor manages one `sherwood session check <sub> --stream` subprocess per monitored syndicate. EventRouter decodes JSON lines, dispatches to per-event handlers that call `ctx.inject_message()` and (for some events) fire-and-forget `sherwood chat <sub> send --markdown`. Phase 2 hooks on `pre_tool_call` (risk checks) and `post_tool_call` (memory writes) intercept agent-initiated Sherwood commands.

**Tech Stack:** Python 3.11+, asyncio, PyYAML, pytest, pytest-asyncio. Depends on Sherwood CLI (`@sherwoodagent/cli` ≥ 0.4.0) installed globally.

**Spec:** [docs/superpowers/specs/2026-04-15-hermes-plugin-design.md](../specs/2026-04-15-hermes-plugin-design.md)

---

## Repository and file layout

The plugin is developed inside the sherwood repo at `hermes-plugin/` (plain directory during implementation). The final task migrates it to a standalone GitHub repo (`imthatcarlos/sherwood-hermes-plugin`) added back as a git submodule. All file paths below are relative to `hermes-plugin/`.

```
hermes-plugin/
├── plugin.yaml                      # Hermes manifest
├── pyproject.toml                   # Python packaging
├── README.md                        # install + first-run UX
├── BOOT.md                          # Hermes startup routine
├── sherwood_monitor/
│   ├── __init__.py                  # register(ctx) — plugin entry point
│   ├── config.py                    # config.yaml loader + dataclass
│   ├── preflight.py                 # CLI version + config check
│   ├── models.py                    # typed records for events + messages
│   ├── router.py                    # EventRouter — dispatch layer
│   ├── handlers.py                  # per-event-type handlers
│   ├── xmtp_post.py                 # fire-and-forget chat send helper
│   ├── supervisor.py                # subprocess lifecycle manager
│   ├── tools.py                     # LLM tool handlers
│   ├── schemas.py                   # LLM tool schemas
│   ├── hooks.py                     # on_session_*, pre/post_tool_call
│   ├── risk.py                      # Phase 2 risk checks
│   ├── memory.py                    # Phase 2 memory writes
│   └── cli.py                       # hermes sherwood <cmd> commands
├── skills/
│   └── sherwood-agent/              # mirrored skill pack (copy from ../skill/)
├── scripts/
│   └── refresh_skill_pack.sh        # manual skill pack refresh helper
├── fixtures/
│   ├── chain_proposal_created.json
│   ├── chain_vote_cast.json
│   ├── chain_proposal_executed.json
│   ├── chain_proposal_settled.json
│   ├── chain_proposal_cancelled.json
│   ├── chain_agent_registered.json
│   ├── xmtp_risk_alert.json
│   ├── xmtp_strategy_proposal.json
│   ├── xmtp_approval_request.json
│   ├── xmtp_trade_signal.json
│   ├── xmtp_message.json
│   └── session_check_output.json    # one-shot catch-up fixture
└── tests/
    ├── __init__.py
    ├── conftest.py
    ├── test_config.py
    ├── test_preflight.py
    ├── test_models.py
    ├── test_router.py
    ├── test_handlers.py
    ├── test_xmtp_post.py
    ├── test_supervisor.py
    ├── test_tools.py
    ├── test_hooks.py
    ├── test_risk.py
    └── test_memory.py
```

Rationale: every module has one responsibility. Tests mirror the module structure one-to-one. Fixtures are JSON so they exercise the real `json.loads` path used in production.

---

## Task 1: Directory scaffolding

**Files:**
- Create: `hermes-plugin/` (plain directory, not yet a submodule)
- Create: `hermes-plugin/sherwood_monitor/__init__.py` (empty)
- Create: `hermes-plugin/tests/__init__.py` (empty)
- Create: `hermes-plugin/tests/conftest.py`
- Create: `hermes-plugin/.gitignore`

- [ ] **Step 1: Create directory tree**

```bash
mkdir -p hermes-plugin/sherwood_monitor hermes-plugin/tests hermes-plugin/fixtures hermes-plugin/skills hermes-plugin/scripts
touch hermes-plugin/sherwood_monitor/__init__.py hermes-plugin/tests/__init__.py
```

- [ ] **Step 2: Write .gitignore**

Create `hermes-plugin/.gitignore`:

```
__pycache__/
*.py[cod]
*.egg-info/
.pytest_cache/
.venv/
build/
dist/
.coverage
htmlcov/
```

- [ ] **Step 3: Write tests/conftest.py**

Create `hermes-plugin/tests/conftest.py`:

```python
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
    ctx.inject_message = MagicMock()
    return ctx
```

- [ ] **Step 4: Commit**

```bash
git add hermes-plugin/
git commit -m "chore(hermes-plugin): scaffold directory structure"
```

---

## Task 2: Python packaging

**Files:**
- Create: `hermes-plugin/pyproject.toml`

- [ ] **Step 1: Write pyproject.toml**

```toml
[build-system]
requires = ["setuptools>=68", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "sherwood-monitor"
version = "0.1.0"
description = "Hermes plugin for Sherwood syndicate monitoring and auto-response"
readme = "README.md"
requires-python = ">=3.11"
license = { text = "MIT" }
authors = [{ name = "Sherwood" }]
dependencies = [
    "PyYAML>=6.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-asyncio>=0.23",
    "pytest-mock>=3.12",
]

[project.entry-points."hermes_agent.plugins"]
sherwood-monitor = "sherwood_monitor"

[tool.setuptools.packages.find]
where = ["."]
include = ["sherwood_monitor*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
asyncio_mode = "auto"
```

- [ ] **Step 2: Verify install works**

Run:
```bash
cd hermes-plugin && python -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"
```
Expected: `Successfully installed sherwood-monitor-0.1.0 pytest-...`

- [ ] **Step 3: Run pytest against empty suite**

Run: `cd hermes-plugin && .venv/bin/pytest -q`
Expected: `no tests ran in 0.XXs` (exit 5 is OK — empty suite)

- [ ] **Step 4: Commit**

```bash
git add hermes-plugin/pyproject.toml
git commit -m "chore(hermes-plugin): add pyproject.toml with dev deps"
```

---

## Task 3: Hermes manifest

**Files:**
- Create: `hermes-plugin/plugin.yaml`

- [ ] **Step 1: Write plugin.yaml**

```yaml
name: sherwood-monitor
version: "0.1.0"
description: Bridges Sherwood syndicate events (on-chain + XMTP) into Hermes. Reactively informs the agent of proposals, votes, settlements, risk alerts, and other lifecycle events.
entry: sherwood_monitor
requires_env: []
```

- [ ] **Step 2: Commit**

```bash
git add hermes-plugin/plugin.yaml
git commit -m "chore(hermes-plugin): add plugin.yaml manifest"
```

---

## Task 4: Event/message record models

**Files:**
- Create: `hermes-plugin/sherwood_monitor/models.py`
- Create: `hermes-plugin/tests/test_models.py`

Plugin consumes two kinds of records from `sherwood session check`. Typing them prevents downstream bugs.

- [ ] **Step 1: Write the failing test**

Create `hermes-plugin/tests/test_models.py`:

```python
import pytest

from sherwood_monitor.models import (
    ChainEvent,
    SessionMessage,
    decode_record,
)


def test_decode_chain_event():
    raw = {
        "source": "chain",
        "type": "ProposalCreated",
        "block": 12345,
        "tx": "0xabc",
        "args": {"proposalId": "1", "proposer": "0xdef"},
    }
    rec = decode_record(raw)
    assert isinstance(rec, ChainEvent)
    assert rec.type == "ProposalCreated"
    assert rec.block == 12345
    assert rec.args["proposalId"] == "1"


def test_decode_xmtp_message():
    raw = {
        "source": "xmtp",
        "id": "msg-1",
        "from": "0xsender",
        "type": "RISK_ALERT",
        "text": "Health factor below 1.2",
        "sentAt": "2026-04-15T12:00:00.000Z",
    }
    rec = decode_record(raw)
    assert isinstance(rec, SessionMessage)
    assert rec.type == "RISK_ALERT"
    assert rec.text == "Health factor below 1.2"


def test_decode_unknown_source_raises():
    with pytest.raises(ValueError, match="unknown source"):
        decode_record({"source": "martian", "type": "Nope"})


def test_decode_non_dict_raises():
    with pytest.raises(ValueError):
        decode_record("not a dict")  # type: ignore[arg-type]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_models.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'sherwood_monitor.models'`

- [ ] **Step 3: Write implementation**

Create `hermes-plugin/sherwood_monitor/models.py`:

```python
"""Typed records for events arriving from `sherwood session check`."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Union


@dataclass(frozen=True)
class ChainEvent:
    """On-chain event emitted by Sherwood vault or governor contracts."""

    type: str
    block: int
    tx: str
    args: dict[str, str] = field(default_factory=dict)
    source: str = "chain"


@dataclass(frozen=True)
class SessionMessage:
    """XMTP message observed in the syndicate group chat."""

    id: str
    type: str
    text: str
    sent_at: str  # ISO 8601
    from_: str  # 'from' is reserved
    source: str = "xmtp"


Record = Union[ChainEvent, SessionMessage]


def decode_record(raw: Any) -> Record:
    """Decode a JSON line from `sherwood session check` into a typed record."""
    if not isinstance(raw, dict):
        raise ValueError(f"expected dict, got {type(raw).__name__}")

    source = raw.get("source")

    if source == "chain":
        return ChainEvent(
            type=str(raw.get("type", "")),
            block=int(raw.get("block", 0)),
            tx=str(raw.get("tx", "")),
            args=dict(raw.get("args", {})),
        )

    if source == "xmtp":
        return SessionMessage(
            id=str(raw.get("id", "")),
            type=str(raw.get("type", "")),
            text=str(raw.get("text", "")),
            sent_at=str(raw.get("sentAt", "")),
            from_=str(raw.get("from", "")),
        )

    raise ValueError(f"unknown source: {source!r}")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_models.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/models.py hermes-plugin/tests/test_models.py
git commit -m "feat(hermes-plugin): typed ChainEvent and SessionMessage records"
```

---

## Task 5: Config loader

**Files:**
- Create: `hermes-plugin/sherwood_monitor/config.py`
- Create: `hermes-plugin/tests/test_config.py`

- [ ] **Step 1: Write the failing test**

Create `hermes-plugin/tests/test_config.py`:

```python
from pathlib import Path

import pytest

from sherwood_monitor.config import Config, DEFAULT_CONFIG_YAML, load_config


def test_load_missing_file_creates_default(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    cfg = load_config(cfg_path)
    assert cfg_path.exists()
    assert cfg_path.read_text() == DEFAULT_CONFIG_YAML
    assert cfg.syndicates == []
    assert cfg.auto_start is False
    assert cfg.xmtp_summaries is True


def test_load_existing_valid(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text(
        """
syndicates:
  - alpha
  - beta
auto_start: true
xmtp_summaries: false
sherwood_bin: /usr/local/bin/sherwood
backoff_max_seconds: 60
inject_mentions_only: false
""".strip()
    )
    cfg = load_config(cfg_path)
    assert cfg.syndicates == ["alpha", "beta"]
    assert cfg.auto_start is True
    assert cfg.xmtp_summaries is False
    assert cfg.sherwood_bin == "/usr/local/bin/sherwood"
    assert cfg.backoff_max_seconds == 60
    assert cfg.inject_mentions_only is False


def test_load_malformed_yaml_raises(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("this: is: not: valid")
    with pytest.raises(ValueError, match="config parse error"):
        load_config(cfg_path)


def test_load_wrong_types_raises(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("syndicates: not-a-list")
    with pytest.raises(ValueError, match="syndicates must be a list"):
        load_config(cfg_path)


def test_load_negative_backoff_raises(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("backoff_max_seconds: -1")
    with pytest.raises(ValueError, match="backoff_max_seconds must be positive"):
        load_config(cfg_path)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_config.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write implementation**

Create `hermes-plugin/sherwood_monitor/config.py`:

```python
"""Config loader for sherwood-monitor plugin."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

DEFAULT_CONFIG_YAML = """# sherwood-monitor config
# Edit `syndicates` to add subdomains you want to monitor.
syndicates: []
auto_start: false
xmtp_summaries: true
sherwood_bin: sherwood
backoff_max_seconds: 30
inject_mentions_only: true
"""


@dataclass(frozen=True)
class Config:
    syndicates: list[str] = field(default_factory=list)
    auto_start: bool = False
    xmtp_summaries: bool = True
    sherwood_bin: str = "sherwood"
    backoff_max_seconds: int = 30
    inject_mentions_only: bool = True


def load_config(path: Path) -> Config:
    """Load config, creating a default file on disk if missing."""
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(DEFAULT_CONFIG_YAML)
        return Config()

    try:
        raw = yaml.safe_load(path.read_text()) or {}
    except yaml.YAMLError as exc:
        raise ValueError(f"config parse error: {exc}") from exc

    syndicates = raw.get("syndicates", [])
    if not isinstance(syndicates, list):
        raise ValueError("syndicates must be a list")

    backoff_max = int(raw.get("backoff_max_seconds", 30))
    if backoff_max <= 0:
        raise ValueError("backoff_max_seconds must be positive")

    return Config(
        syndicates=[str(s) for s in syndicates],
        auto_start=bool(raw.get("auto_start", False)),
        xmtp_summaries=bool(raw.get("xmtp_summaries", True)),
        sherwood_bin=str(raw.get("sherwood_bin", "sherwood")),
        backoff_max_seconds=backoff_max,
        inject_mentions_only=bool(raw.get("inject_mentions_only", True)),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_config.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/config.py hermes-plugin/tests/test_config.py
git commit -m "feat(hermes-plugin): config loader with defaults and validation"
```

---

## Task 6: Preflight check

**Files:**
- Create: `hermes-plugin/sherwood_monitor/preflight.py`
- Create: `hermes-plugin/tests/test_preflight.py`

Checks Sherwood CLI is installed and configured. Returns a structured result so `register()` can decide what to warn about.

- [ ] **Step 1: Write the failing test**

Create `hermes-plugin/tests/test_preflight.py`:

```python
from pathlib import Path
from unittest.mock import MagicMock, patch

from sherwood_monitor.preflight import (
    PreflightResult,
    check_cli_installed,
    check_cli_configured,
    run_preflight,
)


def test_check_cli_installed_ok():
    fake_run = MagicMock(return_value=MagicMock(returncode=0, stdout="0.4.1"))
    with patch("subprocess.run", fake_run):
        ok, version = check_cli_installed("sherwood")
    assert ok is True
    assert version == "0.4.1"


def test_check_cli_installed_missing():
    with patch("subprocess.run", side_effect=FileNotFoundError):
        ok, version = check_cli_installed("sherwood")
    assert ok is False
    assert version is None


def test_check_cli_installed_version_too_old():
    fake_run = MagicMock(return_value=MagicMock(returncode=0, stdout="0.3.9"))
    with patch("subprocess.run", fake_run):
        ok, version = check_cli_installed("sherwood", min_version="0.4.0")
    assert ok is False
    assert version == "0.3.9"


def test_check_cli_configured_ok(tmp_path: Path):
    cfg = tmp_path / ".sherwood" / "config.json"
    cfg.parent.mkdir()
    cfg.write_text("{}")
    assert check_cli_configured(tmp_path) is True


def test_check_cli_configured_missing(tmp_path: Path):
    assert check_cli_configured(tmp_path) is False


def test_run_preflight_all_ok(tmp_path: Path):
    cfg = tmp_path / ".sherwood" / "config.json"
    cfg.parent.mkdir()
    cfg.write_text("{}")
    fake_run = MagicMock(return_value=MagicMock(returncode=0, stdout="0.5.0"))
    with patch("subprocess.run", fake_run):
        result = run_preflight("sherwood", home=tmp_path)
    assert isinstance(result, PreflightResult)
    assert result.cli_ok is True
    assert result.config_ok is True
    assert result.warnings == []


def test_run_preflight_missing_cli(tmp_path: Path):
    with patch("subprocess.run", side_effect=FileNotFoundError):
        result = run_preflight("sherwood", home=tmp_path)
    assert result.cli_ok is False
    assert any("npm i -g @sherwoodagent/cli" in w for w in result.warnings)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_preflight.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `hermes-plugin/sherwood_monitor/preflight.py`:

```python
"""Preflight checks for Sherwood CLI installation and config."""
from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path

MIN_CLI_VERSION = "0.4.0"


@dataclass(frozen=True)
class PreflightResult:
    cli_ok: bool
    cli_version: str | None
    config_ok: bool
    warnings: list[str] = field(default_factory=list)


def _parse_version(s: str) -> tuple[int, ...]:
    return tuple(int(p) for p in s.strip().split(".") if p.isdigit())


def check_cli_installed(
    bin_path: str, min_version: str = MIN_CLI_VERSION
) -> tuple[bool, str | None]:
    """Return (ok, version_string)."""
    try:
        res = subprocess.run(
            [bin_path, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False, None

    if res.returncode != 0:
        return False, None

    version = res.stdout.strip().split()[-1]
    try:
        if _parse_version(version) < _parse_version(min_version):
            return False, version
    except ValueError:
        return False, version

    return True, version


def check_cli_configured(home: Path) -> bool:
    """Return True if `~/.sherwood/config.json` exists."""
    return (home / ".sherwood" / "config.json").exists()


def run_preflight(sherwood_bin: str, home: Path | None = None) -> PreflightResult:
    """Run all preflight checks and collect warnings."""
    home = home or Path.home()
    warnings: list[str] = []

    cli_ok, cli_version = check_cli_installed(sherwood_bin)
    if not cli_ok:
        if cli_version is None:
            warnings.append(
                "Sherwood CLI not found. Install: npm i -g @sherwoodagent/cli"
            )
        else:
            warnings.append(
                f"Sherwood CLI version {cli_version} is below minimum "
                f"{MIN_CLI_VERSION}. Upgrade: npm i -g @sherwoodagent/cli@latest"
            )

    config_ok = check_cli_configured(home)
    if not config_ok:
        warnings.append(
            "Sherwood CLI not configured. Run: sherwood config set"
        )

    return PreflightResult(
        cli_ok=cli_ok,
        cli_version=cli_version,
        config_ok=config_ok,
        warnings=warnings,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_preflight.py -v`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/preflight.py hermes-plugin/tests/test_preflight.py
git commit -m "feat(hermes-plugin): preflight check for Sherwood CLI"
```

---

## Task 7: Create event fixtures

**Files:**
- Create: `hermes-plugin/fixtures/*.json` (12 files)

Fixtures are golden JSON records captured from the real CLI output shape (see [cli/src/commands/session.ts](../../../cli/src/commands/session.ts)).

- [ ] **Step 1: Write chain event fixtures**

Create `hermes-plugin/fixtures/chain_proposal_created.json`:
```json
{
  "source": "chain",
  "type": "ProposalCreated",
  "block": 22501000,
  "tx": "0xaaa111",
  "args": {
    "proposalId": "42",
    "proposer": "0xAgent0000000000000000000000000000000001",
    "vault": "0xVault000000000000000000000000000000000002",
    "performanceFeeBps": "1000",
    "strategyDuration": "604800",
    "executeCallCount": "2",
    "settlementCallCount": "1",
    "metadataURI": "ipfs://QmTest",
    "metadataName": "Aerodrome USDC-ETH LP",
    "metadataDescription": "Provide liquidity for one week"
  }
}
```

Create `hermes-plugin/fixtures/chain_vote_cast.json`:
```json
{
  "source": "chain",
  "type": "VoteCast",
  "block": 22501010,
  "tx": "0xbbb222",
  "args": {
    "proposalId": "42",
    "voter": "0xLP0000000000000000000000000000000000003",
    "support": "0",
    "weight": "1000000000000"
  }
}
```

Create `hermes-plugin/fixtures/chain_proposal_executed.json`:
```json
{
  "source": "chain",
  "type": "ProposalExecuted",
  "block": 22501100,
  "tx": "0xccc333",
  "args": {
    "proposalId": "42",
    "vault": "0xVault000000000000000000000000000000000002",
    "capitalSnapshot": "50000000000"
  }
}
```

Create `hermes-plugin/fixtures/chain_proposal_settled.json`:
```json
{
  "source": "chain",
  "type": "ProposalSettled",
  "block": 22502100,
  "tx": "0xddd444",
  "args": {
    "proposalId": "42",
    "vault": "0xVault000000000000000000000000000000000002",
    "pnl": "1500000000",
    "performanceFee": "150000000",
    "duration": "604800"
  }
}
```

Create `hermes-plugin/fixtures/chain_proposal_cancelled.json`:
```json
{
  "source": "chain",
  "type": "ProposalCancelled",
  "block": 22501050,
  "tx": "0xeee555",
  "args": {
    "proposalId": "42",
    "cancelledBy": "0xAgent0000000000000000000000000000000001"
  }
}
```

Create `hermes-plugin/fixtures/chain_agent_registered.json`:
```json
{
  "source": "chain",
  "type": "AgentRegistered",
  "block": 22500000,
  "tx": "0xfff666",
  "args": {
    "agentId": "7",
    "agentAddress": "0xAgent0000000000000000000000000000000001"
  }
}
```

- [ ] **Step 2: Write XMTP message fixtures**

Create `hermes-plugin/fixtures/xmtp_risk_alert.json`:
```json
{
  "source": "xmtp",
  "id": "msg-risk-1",
  "from": "0xAgent0000000000000000000000000000000001",
  "type": "RISK_ALERT",
  "text": "Moonwell position health factor at 1.15 — action required",
  "sentAt": "2026-04-15T10:30:00.000Z"
}
```

Create `hermes-plugin/fixtures/xmtp_strategy_proposal.json`:
```json
{
  "source": "xmtp",
  "id": "msg-strat-1",
  "from": "0xLP0000000000000000000000000000000000003",
  "type": "STRATEGY_PROPOSAL",
  "text": "Proposing Aerodrome LP strategy for 1 week",
  "sentAt": "2026-04-15T10:31:00.000Z"
}
```

Create `hermes-plugin/fixtures/xmtp_approval_request.json`:
```json
{
  "source": "xmtp",
  "id": "msg-appr-1",
  "from": "0xAgent0000000000000000000000000000000001",
  "type": "APPROVAL_REQUEST",
  "text": "Requesting approval for trade exceeding $10k threshold",
  "sentAt": "2026-04-15T10:32:00.000Z"
}
```

Create `hermes-plugin/fixtures/xmtp_trade_signal.json`:
```json
{
  "source": "xmtp",
  "id": "msg-sig-1",
  "from": "0xAgent0000000000000000000000000000000001",
  "type": "TRADE_SIGNAL",
  "text": "Detected arbitrage opportunity: USDC/USDbC +0.12%",
  "sentAt": "2026-04-15T10:33:00.000Z"
}
```

Create `hermes-plugin/fixtures/xmtp_message.json`:
```json
{
  "source": "xmtp",
  "id": "msg-plain-1",
  "from": "0xLP0000000000000000000000000000000000003",
  "type": "MESSAGE",
  "text": "Hey team, any thoughts on this week's yield?",
  "sentAt": "2026-04-15T10:34:00.000Z"
}
```

Create `hermes-plugin/fixtures/session_check_output.json` (full catch-up shape):
```json
{
  "syndicate": "alpha-fund",
  "messages": [
    {
      "source": "xmtp",
      "id": "msg-plain-1",
      "from": "0xLP0000000000000000000000000000000000003",
      "type": "MESSAGE",
      "text": "Hello",
      "sentAt": "2026-04-15T10:30:00.000Z"
    }
  ],
  "events": [
    {
      "source": "chain",
      "type": "ProposalCreated",
      "block": 22501000,
      "tx": "0xaaa111",
      "args": {"proposalId": "42"}
    }
  ],
  "meta": {
    "newMessages": 1,
    "newEvents": 1,
    "blocksScanned": 1000,
    "lastCheckAt": "never"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add hermes-plugin/fixtures/
git commit -m "test(hermes-plugin): add event and message fixtures"
```

---

## Task 8: XMTP auto-post helper

**Files:**
- Create: `hermes-plugin/sherwood_monitor/xmtp_post.py`
- Create: `hermes-plugin/tests/test_xmtp_post.py`

Fire-and-forget helper that shells out to `sherwood chat <sub> send`. Failures log and are swallowed — never crash the plugin.

- [ ] **Step 1: Write the failing test**

Create `hermes-plugin/tests/test_xmtp_post.py`:

```python
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sherwood_monitor.xmtp_post import post_summary


@pytest.mark.asyncio
async def test_post_summary_spawns_subprocess():
    mock_proc = MagicMock()
    mock_proc.wait = AsyncMock(return_value=0)
    mock_create = AsyncMock(return_value=mock_proc)
    with patch("asyncio.create_subprocess_exec", mock_create):
        await post_summary("sherwood", "alpha-fund", "**hello**")
    assert mock_create.called
    args = mock_create.call_args.args
    assert args[0] == "sherwood"
    assert "chat" in args
    assert "alpha-fund" in args
    assert "send" in args
    assert "--markdown" in args
    assert "**hello**" in args


@pytest.mark.asyncio
async def test_post_summary_swallows_errors(caplog):
    mock_create = AsyncMock(side_effect=OSError("boom"))
    with patch("asyncio.create_subprocess_exec", mock_create):
        await post_summary("sherwood", "alpha-fund", "hi")
    assert any("xmtp post failed" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_post_summary_swallows_nonzero_exit(caplog):
    mock_proc = MagicMock()
    mock_proc.wait = AsyncMock(return_value=1)
    mock_proc.communicate = AsyncMock(return_value=(b"", b"error"))
    mock_create = AsyncMock(return_value=mock_proc)
    with patch("asyncio.create_subprocess_exec", mock_create):
        await post_summary("sherwood", "alpha-fund", "hi")
    assert any("xmtp post failed" in r.message for r in caplog.records)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_xmtp_post.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `hermes-plugin/sherwood_monitor/xmtp_post.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_xmtp_post.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/xmtp_post.py hermes-plugin/tests/test_xmtp_post.py
git commit -m "feat(hermes-plugin): fire-and-forget XMTP post helper"
```

---

## Task 9: Event handlers — chain events

**Files:**
- Create: `hermes-plugin/sherwood_monitor/handlers.py`
- Create: `hermes-plugin/tests/test_handlers.py`

Each handler takes `(subdomain, record, ctx, cfg, post_fn)` and decides what to inject + whether to post to XMTP. Pure dispatch — no state.

- [ ] **Step 1: Write the failing test**

Create `hermes-plugin/tests/test_handlers.py`:

```python
from unittest.mock import AsyncMock, MagicMock

import pytest

from sherwood_monitor.config import Config
from sherwood_monitor.handlers import handle_chain_event
from sherwood_monitor.models import ChainEvent


@pytest.fixture
def cfg():
    return Config(xmtp_summaries=True, sherwood_bin="sherwood")


def _event(type_: str, args: dict[str, str] | None = None) -> ChainEvent:
    return ChainEvent(type=type_, block=1, tx="0x0", args=args or {})


@pytest.mark.asyncio
async def test_proposal_created_injects_and_posts(cfg):
    ctx = MagicMock()
    post = AsyncMock()
    ev = _event(
        "ProposalCreated",
        {
            "proposalId": "1",
            "proposer": "0xabc",
            "metadataName": "Aero LP",
            "metadataDescription": "1 week",
            "performanceFeeBps": "1000",
            "strategyDuration": "604800",
        },
    )
    await handle_chain_event("alpha", ev, ctx, cfg, post)
    ctx.inject_message.assert_called_once()
    call_content = ctx.inject_message.call_args.kwargs["content"]
    assert 'syndicate="alpha"' in call_content
    assert 'type="ProposalCreated"' in call_content
    assert "Aero LP" in call_content
    post.assert_called_once()
    assert post.call_args.args[0] == "sherwood"
    assert post.call_args.args[1] == "alpha"
    assert "Proposal #1" in post.call_args.args[2]


@pytest.mark.asyncio
async def test_proposal_settled_injects_and_posts(cfg):
    ctx = MagicMock()
    post = AsyncMock()
    ev = _event(
        "ProposalSettled",
        {"proposalId": "1", "pnl": "500000000", "duration": "604800", "performanceFee": "50000000"},
    )
    await handle_chain_event("alpha", ev, ctx, cfg, post)
    ctx.inject_message.assert_called_once()
    post.assert_called_once()
    assert "pnl" in post.call_args.args[2].lower()


@pytest.mark.asyncio
async def test_vote_cast_injects_no_post(cfg):
    ctx = MagicMock()
    post = AsyncMock()
    ev = _event(
        "VoteCast",
        {"proposalId": "1", "voter": "0xabc", "support": "1", "weight": "1"},
    )
    await handle_chain_event("alpha", ev, ctx, cfg, post)
    ctx.inject_message.assert_called_once()
    post.assert_not_called()


@pytest.mark.asyncio
async def test_xmtp_summaries_disabled_suppresses_post(cfg):
    ctx = MagicMock()
    post = AsyncMock()
    cfg_no_post = Config(xmtp_summaries=False, sherwood_bin="sherwood")
    ev = _event("ProposalCreated", {"proposalId": "1"})
    await handle_chain_event("alpha", ev, ctx, cfg_no_post, post)
    ctx.inject_message.assert_called_once()
    post.assert_not_called()


@pytest.mark.asyncio
async def test_deposited_and_withdrawn_skipped(cfg):
    # Not in our routing table — fall through silently
    ctx = MagicMock()
    post = AsyncMock()
    ev = _event("Deposited", {"amount": "100"})
    await handle_chain_event("alpha", ev, ctx, cfg, post)
    ctx.inject_message.assert_called_once()  # yes, context injected
    post.assert_not_called()


@pytest.mark.asyncio
async def test_unknown_event_logged_not_raised(cfg, caplog):
    ctx = MagicMock()
    post = AsyncMock()
    ev = _event("UFOSighting", {})
    await handle_chain_event("alpha", ev, ctx, cfg, post)
    ctx.inject_message.assert_not_called()
    post.assert_not_called()
    assert any("unhandled" in r.message.lower() for r in caplog.records)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_handlers.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation (chain handlers only)**

Create `hermes-plugin/sherwood_monitor/handlers.py`:

```python
"""Per-event-type handlers: decide how to inject + whether to post to XMTP."""
from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

from .config import Config
from .models import ChainEvent, SessionMessage

_log = logging.getLogger(__name__)

PostFn = Callable[[str, str, str], Awaitable[None]]

# Events we inject as context but don't auto-post
CHAIN_INJECT_ONLY = {
    "VoteCast",
    "AgentRegistered",
    "AgentRemoved",
    "DepositorApproved",
    "DepositorRemoved",
    "RedemptionsLockedEvent",
    "RedemptionsUnlockedEvent",
    "Deposited",
    "Withdrawn",
}

# Events that inject AND auto-post a summary to XMTP
CHAIN_INJECT_AND_POST = {
    "ProposalCreated",
    "ProposalExecuted",
    "ProposalSettled",
    "ProposalCancelled",
}


def _format_chain_injection(subdomain: str, ev: ChainEvent, priority: str = "normal") -> str:
    args_lines = "\n".join(f"  {k}: {v}" for k, v in ev.args.items())
    return (
        f'<sherwood-event syndicate="{subdomain}" source="chain" '
        f'type="{ev.type}" priority="{priority}" block="{ev.block}" tx="{ev.tx}">\n'
        f"<args>\n{args_lines}\n</args>\n"
        f"</sherwood-event>"
    )


def _format_proposal_created_summary(ev: ChainEvent) -> str:
    name = ev.args.get("metadataName", "(unnamed)")
    desc = ev.args.get("metadataDescription", "")
    proposer = ev.args.get("proposer", "?")
    fee_bps = ev.args.get("performanceFeeBps", "?")
    duration = ev.args.get("strategyDuration", "?")
    try:
        duration_days = f"{int(duration) // 86400}d" if duration != "?" else "?"
    except ValueError:
        duration_days = "?"
    return (
        f"**Proposal #{ev.args.get('proposalId', '?')} — {name}**\n"
        f"{desc}\n"
        f"Proposer: `{proposer}` | Fee: {fee_bps} bps | Duration: {duration_days}"
    )


def _format_proposal_executed_summary(ev: ChainEvent) -> str:
    capital = ev.args.get("capitalSnapshot", "?")
    try:
        capital_usd = f"${int(capital) / 1_000_000:,.2f}"
    except ValueError:
        capital_usd = capital
    return (
        f"**Proposal #{ev.args.get('proposalId', '?')} executed** — "
        f"capital deployed: {capital_usd} (USDC)"
    )


def _format_proposal_settled_summary(ev: ChainEvent) -> str:
    pnl_raw = ev.args.get("pnl", "0")
    try:
        pnl_usd = f"${int(pnl_raw) / 1_000_000:+,.2f}"
    except ValueError:
        pnl_usd = pnl_raw
    duration = ev.args.get("duration", "?")
    try:
        duration_days = f"{int(duration) // 86400}d"
    except ValueError:
        duration_days = "?"
    return (
        f"**Proposal #{ev.args.get('proposalId', '?')} settled** — "
        f"pnl: {pnl_usd}, duration: {duration_days}"
    )


def _format_proposal_cancelled_summary(ev: ChainEvent) -> str:
    return (
        f"**Proposal #{ev.args.get('proposalId', '?')} cancelled** "
        f"by `{ev.args.get('cancelledBy', '?')}`"
    )


_CHAIN_SUMMARY_FORMATTERS: dict[str, Callable[[ChainEvent], str]] = {
    "ProposalCreated": _format_proposal_created_summary,
    "ProposalExecuted": _format_proposal_executed_summary,
    "ProposalSettled": _format_proposal_settled_summary,
    "ProposalCancelled": _format_proposal_cancelled_summary,
}


async def handle_chain_event(
    subdomain: str,
    ev: ChainEvent,
    ctx: Any,
    cfg: Config,
    post_fn: PostFn,
) -> None:
    """Route a single on-chain event."""
    if ev.type not in CHAIN_INJECT_ONLY and ev.type not in CHAIN_INJECT_AND_POST:
        _log.info("unhandled chain event type: %s", ev.type)
        return

    ctx.inject_message(content=_format_chain_injection(subdomain, ev), role="user")

    if ev.type in CHAIN_INJECT_AND_POST and cfg.xmtp_summaries:
        formatter = _CHAIN_SUMMARY_FORMATTERS.get(ev.type)
        if formatter is not None:
            summary = formatter(ev)
            await post_fn(cfg.sherwood_bin, subdomain, summary)


async def handle_xmtp_message(
    subdomain: str,
    msg: SessionMessage,
    ctx: Any,
    cfg: Config,
    post_fn: PostFn,
) -> None:
    """Route a single XMTP message (filled in Task 10)."""
    raise NotImplementedError
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_handlers.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/handlers.py hermes-plugin/tests/test_handlers.py
git commit -m "feat(hermes-plugin): chain event handlers with XMTP summaries"
```

---

## Task 10: Event handlers — XMTP messages

**Files:**
- Modify: `hermes-plugin/sherwood_monitor/handlers.py` (replace `handle_xmtp_message` stub)
- Modify: `hermes-plugin/tests/test_handlers.py` (append tests)

- [ ] **Step 1: Append failing tests**

Append to `hermes-plugin/tests/test_handlers.py`:

```python
from sherwood_monitor.handlers import handle_xmtp_message
from sherwood_monitor.models import SessionMessage


def _msg(type_: str, text: str = "hi", sender: str = "0xpeer") -> SessionMessage:
    return SessionMessage(
        id="x",
        type=type_,
        text=text,
        sent_at="2026-04-15T10:00:00Z",
        from_=sender,
    )


@pytest.mark.asyncio
async def test_risk_alert_injects_with_high_priority(cfg):
    ctx = MagicMock()
    post = AsyncMock()
    await handle_xmtp_message("alpha", _msg("RISK_ALERT", "HF low"), ctx, cfg, post)
    ctx.inject_message.assert_called_once()
    content = ctx.inject_message.call_args.kwargs["content"]
    assert 'priority="high"' in content
    assert "HF low" in content
    post.assert_not_called()


@pytest.mark.asyncio
async def test_approval_request_injects_with_human_escalate(cfg):
    ctx = MagicMock()
    post = AsyncMock()
    await handle_xmtp_message(
        "alpha", _msg("APPROVAL_REQUEST", "trade"), ctx, cfg, post
    )
    content = ctx.inject_message.call_args.kwargs["content"]
    assert "human-escalate" in content


@pytest.mark.asyncio
async def test_plain_message_without_mention_skipped(cfg):
    ctx = MagicMock()
    post = AsyncMock()
    await handle_xmtp_message(
        "alpha", _msg("MESSAGE", "hello team"), ctx, cfg, post
    )
    ctx.inject_message.assert_not_called()


@pytest.mark.asyncio
async def test_plain_message_with_mention_injected(cfg):
    ctx = MagicMock()
    post = AsyncMock()
    # mention token: the plugin is agnostic to which handle is "us";
    # injection rule is "contains @"
    await handle_xmtp_message(
        "alpha", _msg("MESSAGE", "@agent thoughts?"), ctx, cfg, post
    )
    ctx.inject_message.assert_called_once()


@pytest.mark.asyncio
async def test_plain_message_mention_respects_config(cfg):
    ctx = MagicMock()
    post = AsyncMock()
    cfg_all = Config(inject_mentions_only=False)
    await handle_xmtp_message(
        "alpha", _msg("MESSAGE", "no mention"), ctx, cfg_all, post
    )
    ctx.inject_message.assert_called_once()


@pytest.mark.asyncio
async def test_reaction_always_skipped(cfg):
    ctx = MagicMock()
    post = AsyncMock()
    cfg_all = Config(inject_mentions_only=False)
    await handle_xmtp_message("alpha", _msg("REACTION", "👍"), ctx, cfg_all, post)
    ctx.inject_message.assert_not_called()


@pytest.mark.asyncio
async def test_strategy_proposal_injects(cfg):
    ctx = MagicMock()
    post = AsyncMock()
    await handle_xmtp_message(
        "alpha", _msg("STRATEGY_PROPOSAL", "Aero LP"), ctx, cfg, post
    )
    ctx.inject_message.assert_called_once()
```

- [ ] **Step 2: Replace the handle_xmtp_message stub**

In `hermes-plugin/sherwood_monitor/handlers.py`, replace the `handle_xmtp_message` stub with:

```python
# XMTP message types that always get injected with specific priority
_XMTP_PRIORITY: dict[str, str] = {
    "RISK_ALERT": "high",
    "APPROVAL_REQUEST": "human-escalate",
    "STRATEGY_PROPOSAL": "normal",
    "TRADE_SIGNAL": "normal",
    "POSITION_UPDATE": "low",
    "LP_REPORT": "low",
    "TRADE_EXECUTED": "low",
    "MEMBER_JOIN": "low",
    "RAGEQUIT_NOTICE": "normal",
    "AGENT_REGISTERED": "low",
    "X402_RESEARCH": "normal",
}

# Types never injected regardless of config
_XMTP_NEVER_INJECT = {"REACTION"}


def _format_xmtp_injection(subdomain: str, msg: SessionMessage, priority: str) -> str:
    return (
        f'<sherwood-event syndicate="{subdomain}" source="xmtp" '
        f'type="{msg.type}" priority="{priority}" from="{msg.from_}" '
        f'sentAt="{msg.sent_at}">\n'
        f"{msg.text}\n"
        f"</sherwood-event>"
    )


async def handle_xmtp_message(
    subdomain: str,
    msg: SessionMessage,
    ctx: Any,
    cfg: Config,
    post_fn: PostFn,
) -> None:
    """Route a single XMTP message."""
    if msg.type in _XMTP_NEVER_INJECT:
        return

    # Plain MESSAGE: respect inject_mentions_only
    if msg.type == "MESSAGE":
        if cfg.inject_mentions_only and "@" not in msg.text:
            return
        ctx.inject_message(
            content=_format_xmtp_injection(subdomain, msg, "normal"), role="user"
        )
        return

    priority = _XMTP_PRIORITY.get(msg.type)
    if priority is None:
        _log.info("unhandled xmtp message type: %s", msg.type)
        return

    ctx.inject_message(
        content=_format_xmtp_injection(subdomain, msg, priority), role="user"
    )
```

- [ ] **Step 3: Run tests to verify all pass**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_handlers.py -v`
Expected: 13 passed (6 from Task 9 + 7 new)

- [ ] **Step 4: Commit**

```bash
git add hermes-plugin/sherwood_monitor/handlers.py hermes-plugin/tests/test_handlers.py
git commit -m "feat(hermes-plugin): xmtp message handlers with priority tagging"
```

---

## Task 11: EventRouter

**Files:**
- Create: `hermes-plugin/sherwood_monitor/router.py`
- Create: `hermes-plugin/tests/test_router.py`

Thin dispatch layer — decodes a raw dict, picks the right handler, calls it. All exceptions logged, never raised.

- [ ] **Step 1: Write the failing test**

Create `hermes-plugin/tests/test_router.py`:

```python
from unittest.mock import AsyncMock, MagicMock

import pytest

from sherwood_monitor.config import Config
from sherwood_monitor.router import EventRouter


@pytest.mark.asyncio
async def test_routes_chain_event(fixture):
    cfg = Config(xmtp_summaries=True)
    ctx = MagicMock()
    post = AsyncMock()
    router = EventRouter(ctx=ctx, cfg=cfg, post_fn=post)
    await router.route("alpha", fixture("chain_proposal_created"))
    ctx.inject_message.assert_called_once()
    post.assert_called_once()


@pytest.mark.asyncio
async def test_routes_xmtp_message(fixture):
    cfg = Config()
    ctx = MagicMock()
    post = AsyncMock()
    router = EventRouter(ctx=ctx, cfg=cfg, post_fn=post)
    await router.route("alpha", fixture("xmtp_risk_alert"))
    ctx.inject_message.assert_called_once()


@pytest.mark.asyncio
async def test_malformed_record_logged_not_raised(caplog):
    cfg = Config()
    ctx = MagicMock()
    post = AsyncMock()
    router = EventRouter(ctx=ctx, cfg=cfg, post_fn=post)
    await router.route("alpha", {"source": "martian"})
    ctx.inject_message.assert_not_called()
    assert any("decode error" in r.message.lower() for r in caplog.records)


@pytest.mark.asyncio
async def test_handler_exception_logged_not_raised(caplog):
    cfg = Config(xmtp_summaries=True)
    ctx = MagicMock()
    ctx.inject_message.side_effect = RuntimeError("boom")
    post = AsyncMock()
    router = EventRouter(ctx=ctx, cfg=cfg, post_fn=post)
    # Should not raise despite ctx.inject_message blowing up
    await router.route(
        "alpha",
        {
            "source": "chain",
            "type": "VoteCast",
            "block": 1,
            "tx": "0x",
            "args": {},
        },
    )
    assert any("handler error" in r.message.lower() for r in caplog.records)


@pytest.mark.asyncio
async def test_counter_increments_on_route(fixture):
    cfg = Config()
    ctx = MagicMock()
    post = AsyncMock()
    router = EventRouter(ctx=ctx, cfg=cfg, post_fn=post)
    await router.route("alpha", fixture("chain_vote_cast"))
    await router.route("alpha", fixture("chain_proposal_settled"))
    assert router.events_seen("alpha") == 2
    assert router.last_event_at("alpha") is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_router.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `hermes-plugin/sherwood_monitor/router.py`:

```python
"""EventRouter: decode a raw record and dispatch to the right handler."""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from typing import Any

from .config import Config
from .handlers import PostFn, handle_chain_event, handle_xmtp_message
from .models import ChainEvent, SessionMessage, decode_record

_log = logging.getLogger(__name__)


class EventRouter:
    def __init__(self, ctx: Any, cfg: Config, post_fn: PostFn) -> None:
        self._ctx = ctx
        self._cfg = cfg
        self._post_fn = post_fn
        self._events_seen: dict[str, int] = defaultdict(int)
        self._last_event_at: dict[str, float] = {}

    async def route(self, subdomain: str, raw: Any) -> None:
        try:
            rec = decode_record(raw)
        except ValueError as exc:
            _log.warning("decode error on %s: %s", subdomain, exc)
            return

        self._events_seen[subdomain] += 1
        self._last_event_at[subdomain] = time.time()

        try:
            if isinstance(rec, ChainEvent):
                await handle_chain_event(subdomain, rec, self._ctx, self._cfg, self._post_fn)
            elif isinstance(rec, SessionMessage):
                await handle_xmtp_message(subdomain, rec, self._ctx, self._cfg, self._post_fn)
        except Exception as exc:
            _log.exception("handler error on %s: %s", subdomain, exc)

    def events_seen(self, subdomain: str) -> int:
        return self._events_seen.get(subdomain, 0)

    def last_event_at(self, subdomain: str) -> float | None:
        return self._last_event_at.get(subdomain)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_router.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/router.py hermes-plugin/tests/test_router.py
git commit -m "feat(hermes-plugin): EventRouter with decode + dispatch + counters"
```

---

## Task 12: Supervisor — happy path

**Files:**
- Create: `hermes-plugin/sherwood_monitor/supervisor.py`
- Create: `hermes-plugin/tests/test_supervisor.py`

Core subprocess lifecycle. Start with happy path (spawn, read JSON lines, route, clean exit). Tasks 13 and 14 add backoff and graceful shutdown.

- [ ] **Step 1: Write the failing test**

Create `hermes-plugin/tests/test_supervisor.py`:

```python
import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sherwood_monitor.config import Config
from sherwood_monitor.supervisor import Supervisor


def _fake_proc(stdout_lines: list[str], stderr_lines: list[str] = (), rc: int = 0):
    proc = MagicMock()
    proc.pid = 12345
    proc.stdout = MagicMock()
    proc.stderr = MagicMock()

    stdout_iter = iter(stdout_lines)

    async def stdout_readline():
        try:
            return next(stdout_iter).encode() + b"\n"
        except StopIteration:
            return b""

    stderr_iter = iter(stderr_lines)

    async def stderr_readline():
        try:
            return next(stderr_iter).encode() + b"\n"
        except StopIteration:
            return b""

    proc.stdout.readline = stdout_readline
    proc.stderr.readline = stderr_readline
    proc.wait = AsyncMock(return_value=rc)
    proc.terminate = MagicMock()
    proc.kill = MagicMock()
    return proc


@pytest.mark.asyncio
async def test_start_spawns_subprocess_and_routes_events():
    cfg = Config(sherwood_bin="sherwood")
    router = MagicMock()
    router.route = AsyncMock()

    line = json.dumps({"source": "chain", "type": "VoteCast", "block": 1, "tx": "0x", "args": {}})
    proc = _fake_proc([line])

    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)) as mock_spawn:
        sup = Supervisor(cfg=cfg, router=router)
        await sup.start("alpha")
        await asyncio.wait_for(sup.wait_until_exit("alpha"), timeout=2)
        args = mock_spawn.call_args.args
        assert args[0] == "sherwood"
        assert "session" in args and "check" in args and "alpha" in args and "--stream" in args
        router.route.assert_called_once()
        called_sub, called_raw = router.route.call_args.args
        assert called_sub == "alpha"
        assert called_raw["type"] == "VoteCast"


@pytest.mark.asyncio
async def test_malformed_json_skipped():
    cfg = Config()
    router = MagicMock()
    router.route = AsyncMock()
    proc = _fake_proc(["not json"])

    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        sup = Supervisor(cfg=cfg, router=router)
        await sup.start("alpha")
        await asyncio.wait_for(sup.wait_until_exit("alpha"), timeout=2)
        router.route.assert_not_called()


@pytest.mark.asyncio
async def test_status_reports_live_subprocess():
    cfg = Config()
    router = MagicMock()
    router.route = AsyncMock()
    router.events_seen = MagicMock(return_value=3)
    router.last_event_at = MagicMock(return_value=1_700_000_000.0)

    # Make readline block forever so the supervisor task stays "alive"
    proc = _fake_proc([])

    async def never_return():
        await asyncio.sleep(3600)

    proc.stdout.readline = never_return

    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        sup = Supervisor(cfg=cfg, router=router)
        await sup.start("alpha")
        await asyncio.sleep(0.05)  # let the task spin up
        status = sup.status()
        assert status["syndicates"][0]["subdomain"] == "alpha"
        assert status["syndicates"][0]["pid"] == 12345
        assert status["syndicates"][0]["events_seen"] == 3
        await sup.stop_all()


@pytest.mark.asyncio
async def test_stderr_ring_buffer():
    cfg = Config()
    router = MagicMock()
    router.route = AsyncMock()
    proc = _fake_proc(
        stdout_lines=[],
        stderr_lines=[f"error {i}" for i in range(5)],
    )

    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        sup = Supervisor(cfg=cfg, router=router)
        await sup.start("alpha")
        await asyncio.wait_for(sup.wait_until_exit("alpha"), timeout=2)
        tail = sup.stderr_tail("alpha")
        assert "error 4" in tail[-1]
        assert len(tail) <= 200
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_supervisor.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation (happy path only — no backoff or shutdown yet)**

Create `hermes-plugin/sherwood_monitor/supervisor.py`:

```python
"""Supervisor: manages one `sherwood session check --stream` subprocess per syndicate."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from .config import Config
from .router import EventRouter

_log = logging.getLogger(__name__)

_STDERR_RING_SIZE = 200


@dataclass
class _State:
    subdomain: str
    proc: Any = None
    started_at: float = 0.0
    stop_requested: bool = False
    stderr_tail: deque[str] = field(default_factory=lambda: deque(maxlen=_STDERR_RING_SIZE))
    task: asyncio.Task | None = None
    exit_event: asyncio.Event = field(default_factory=asyncio.Event)


class Supervisor:
    def __init__(self, cfg: Config, router: EventRouter) -> None:
        self._cfg = cfg
        self._router = router
        self._states: dict[str, _State] = {}

    async def start(self, subdomain: str) -> int:
        """Spawn supervisor task for `subdomain`. Returns subprocess PID."""
        if subdomain in self._states:
            s = self._states[subdomain]
            if s.task and not s.task.done():
                return s.proc.pid if s.proc else 0

        state = _State(subdomain=subdomain)
        self._states[subdomain] = state
        state.task = asyncio.create_task(self._supervise(state), name=f"sherwood-{subdomain}")

        # Wait briefly for the subprocess to be assigned so start() has a pid to return
        for _ in range(50):
            if state.proc is not None:
                return state.proc.pid
            await asyncio.sleep(0.01)
        return 0

    async def stop(self, subdomain: str) -> None:
        state = self._states.get(subdomain)
        if not state:
            return
        state.stop_requested = True
        if state.proc is not None:
            try:
                state.proc.terminate()
            except ProcessLookupError:
                pass
        if state.task is not None:
            try:
                await asyncio.wait_for(state.task, timeout=5)
            except asyncio.TimeoutError:
                state.task.cancel()

    async def stop_all(self) -> None:
        await asyncio.gather(
            *(self.stop(sub) for sub in list(self._states.keys())),
            return_exceptions=True,
        )

    async def wait_until_exit(self, subdomain: str) -> None:
        state = self._states.get(subdomain)
        if state is None:
            return
        await state.exit_event.wait()

    def status(self) -> dict:
        out = []
        now = time.time()
        for sub, state in self._states.items():
            pid = state.proc.pid if state.proc is not None else 0
            uptime = int(now - state.started_at) if state.started_at else 0
            out.append(
                {
                    "subdomain": sub,
                    "pid": pid,
                    "uptime_seconds": uptime,
                    "events_seen": self._router.events_seen(sub),
                    "last_event_at": self._router.last_event_at(sub),
                    "stderr_tail": list(state.stderr_tail)[-10:],
                }
            )
        return {"syndicates": out}

    def stderr_tail(self, subdomain: str) -> list[str]:
        s = self._states.get(subdomain)
        return list(s.stderr_tail) if s else []

    async def _supervise(self, state: _State) -> None:
        try:
            await self._run_once(state)
        finally:
            state.exit_event.set()

    async def _run_once(self, state: _State) -> None:
        proc = await asyncio.create_subprocess_exec(
            self._cfg.sherwood_bin,
            "session",
            "check",
            state.subdomain,
            "--stream",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        state.proc = proc
        state.started_at = time.time()

        stdout_task = asyncio.create_task(self._read_stdout(state))
        stderr_task = asyncio.create_task(self._read_stderr(state))

        try:
            await proc.wait()
        finally:
            stdout_task.cancel()
            stderr_task.cancel()
            await asyncio.gather(stdout_task, stderr_task, return_exceptions=True)

    async def _read_stdout(self, state: _State) -> None:
        proc = state.proc
        if proc is None or proc.stdout is None:
            return
        while True:
            line = await proc.stdout.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").strip()
            if not text:
                continue
            try:
                raw = json.loads(text)
            except json.JSONDecodeError:
                _log.warning("malformed JSON on %s: %r", state.subdomain, text[:200])
                continue
            await self._router.route(state.subdomain, raw)

    async def _read_stderr(self, state: _State) -> None:
        proc = state.proc
        if proc is None or proc.stderr is None:
            return
        while True:
            line = await proc.stderr.readline()
            if not line:
                return
            state.stderr_tail.append(line.decode("utf-8", "replace").rstrip())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_supervisor.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/supervisor.py hermes-plugin/tests/test_supervisor.py
git commit -m "feat(hermes-plugin): supervisor happy path + status + stderr ring"
```

---

## Task 13: Supervisor — backoff and restart

**Files:**
- Modify: `hermes-plugin/sherwood_monitor/supervisor.py`
- Modify: `hermes-plugin/tests/test_supervisor.py`

- [ ] **Step 1: Append failing tests**

Append to `hermes-plugin/tests/test_supervisor.py`:

```python
@pytest.mark.asyncio
async def test_restart_on_exit_with_backoff(monkeypatch):
    cfg = Config(backoff_max_seconds=1)  # tight bound for test
    router = MagicMock()
    router.route = AsyncMock()

    # sequence of procs that exit immediately, second one stays alive
    procs = [_fake_proc([]) for _ in range(2)]

    async def stay_alive():
        await asyncio.sleep(5)

    procs[1].stdout.readline = stay_alive

    call_count = 0

    async def fake_spawn(*args, **kwargs):
        nonlocal call_count
        p = procs[call_count]
        call_count += 1
        return p

    sleeps: list[float] = []

    async def fake_sleep(t):
        sleeps.append(t)

    monkeypatch.setattr("asyncio.create_subprocess_exec", fake_spawn)
    monkeypatch.setattr("sherwood_monitor.supervisor.asyncio.sleep", fake_sleep)

    sup = Supervisor(cfg=cfg, router=router)
    await sup.start("alpha")
    # Give both spawns a chance
    for _ in range(20):
        if call_count >= 2:
            break
        await asyncio.sleep(0.01)
    await sup.stop_all()
    assert call_count >= 2
    assert any(s >= 1 for s in sleeps)


@pytest.mark.asyncio
async def test_no_restart_when_stop_requested(monkeypatch):
    cfg = Config()
    router = MagicMock()
    router.route = AsyncMock()

    procs_spawned = 0

    async def fake_spawn(*args, **kwargs):
        nonlocal procs_spawned
        procs_spawned += 1
        return _fake_proc([])

    monkeypatch.setattr("asyncio.create_subprocess_exec", fake_spawn)

    sup = Supervisor(cfg=cfg, router=router)
    await sup.start("alpha")
    await sup.stop("alpha")
    await asyncio.sleep(0.05)
    # Exactly one spawn — stop short-circuited restart
    assert procs_spawned == 1
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_supervisor.py::test_restart_on_exit_with_backoff tests/test_supervisor.py::test_no_restart_when_stop_requested -v`
Expected: FAIL — supervisor doesn't restart yet

- [ ] **Step 3: Update supervisor to loop with backoff**

In `hermes-plugin/sherwood_monitor/supervisor.py`, replace `_supervise` with:

```python
    async def _supervise(self, state: _State) -> None:
        backoff = 1
        try:
            while not state.stop_requested:
                run_start = time.time()
                try:
                    await self._run_once(state)
                except Exception as exc:
                    _log.exception("subprocess run failed on %s: %s", state.subdomain, exc)

                if state.stop_requested:
                    break

                if time.time() - run_start > 60:
                    backoff = 1  # stable run, reset

                _log.info(
                    "sherwood session for %s exited; restarting in %ds",
                    state.subdomain,
                    backoff,
                )
                await asyncio.sleep(backoff)
                backoff = min(self._cfg.backoff_max_seconds, backoff * 2)
        finally:
            state.exit_event.set()
```

- [ ] **Step 4: Run tests**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_supervisor.py -v`
Expected: 6 passed (including 4 original + 2 new)

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/supervisor.py hermes-plugin/tests/test_supervisor.py
git commit -m "feat(hermes-plugin): supervisor exponential backoff on subprocess exit"
```

---

## Task 14: Supervisor — graceful shutdown

**Files:**
- Modify: `hermes-plugin/sherwood_monitor/supervisor.py`
- Modify: `hermes-plugin/tests/test_supervisor.py`

Ensure `stop()` SIGTERMs, waits 5s, then SIGKILLs if needed.

- [ ] **Step 1: Append failing tests**

Append to `hermes-plugin/tests/test_supervisor.py`:

```python
@pytest.mark.asyncio
async def test_stop_sends_sigterm_then_sigkill(monkeypatch):
    cfg = Config()
    router = MagicMock()
    router.route = AsyncMock()

    # proc that refuses to exit on SIGTERM
    proc = _fake_proc([])

    async def never_exit():
        await asyncio.sleep(60)

    proc.wait = AsyncMock(side_effect=never_exit)

    monkeypatch.setattr("asyncio.create_subprocess_exec", AsyncMock(return_value=proc))
    # Speed up the grace period
    monkeypatch.setattr("sherwood_monitor.supervisor.TERMINATION_GRACE_SEC", 0.05)

    sup = Supervisor(cfg=cfg, router=router)
    await sup.start("alpha")
    await sup.stop("alpha")
    proc.terminate.assert_called_once()
    proc.kill.assert_called_once()


@pytest.mark.asyncio
async def test_stop_all_cleans_up_every_state(monkeypatch):
    cfg = Config()
    router = MagicMock()
    router.route = AsyncMock()

    procs = [_fake_proc([]), _fake_proc([])]

    async def hold():
        await asyncio.sleep(60)

    for p in procs:
        p.stdout.readline = hold

    spawned = iter(procs)

    async def fake_spawn(*args, **kwargs):
        return next(spawned)

    monkeypatch.setattr("asyncio.create_subprocess_exec", fake_spawn)

    sup = Supervisor(cfg=cfg, router=router)
    await sup.start("alpha")
    await sup.start("beta")
    await sup.stop_all()
    for p in procs:
        p.terminate.assert_called_once()
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_supervisor.py::test_stop_sends_sigterm_then_sigkill tests/test_supervisor.py::test_stop_all_cleans_up_every_state -v`
Expected: FAIL — current stop doesn't escalate to SIGKILL

- [ ] **Step 3: Update stop with grace period + SIGKILL**

In `hermes-plugin/sherwood_monitor/supervisor.py`, add module constant and update `stop`:

```python
TERMINATION_GRACE_SEC = 5.0


class Supervisor:
    # ... existing __init__ ...

    async def stop(self, subdomain: str) -> None:
        state = self._states.get(subdomain)
        if not state:
            return
        state.stop_requested = True
        proc = state.proc
        if proc is not None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=TERMINATION_GRACE_SEC)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
        if state.task is not None and not state.task.done():
            state.task.cancel()
            try:
                await state.task
            except (asyncio.CancelledError, Exception):
                pass
```

- [ ] **Step 4: Run tests**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_supervisor.py -v`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/supervisor.py hermes-plugin/tests/test_supervisor.py
git commit -m "feat(hermes-plugin): supervisor SIGTERM then SIGKILL on stop"
```

---

## Task 15: Tool schemas + handlers

**Files:**
- Create: `hermes-plugin/sherwood_monitor/schemas.py`
- Create: `hermes-plugin/sherwood_monitor/tools.py`
- Create: `hermes-plugin/tests/test_tools.py`

LLM-callable tools: start/stop/status. All handlers return JSON strings per Hermes convention.

- [ ] **Step 1: Write the failing test**

Create `hermes-plugin/tests/test_tools.py`:

```python
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from sherwood_monitor.tools import make_handlers


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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_tools.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write schemas**

Create `hermes-plugin/sherwood_monitor/schemas.py`:

```python
"""JSON schemas for LLM-callable tools."""
from __future__ import annotations

START = {
    "name": "sherwood_monitor_start",
    "description": (
        "Start monitoring a Sherwood syndicate. Spawns a streaming subprocess "
        "that forwards on-chain events and XMTP messages into this conversation. "
        "Use this when the user asks to watch a new syndicate or after adding "
        "one to the config."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "subdomain": {
                "type": "string",
                "description": "Sherwood syndicate subdomain, e.g. 'alpha-fund'",
            }
        },
        "required": ["subdomain"],
    },
}

STOP = {
    "name": "sherwood_monitor_stop",
    "description": (
        "Stop monitoring a Sherwood syndicate. Terminates the streaming "
        "subprocess. Use when the user wants to stop receiving events from "
        "a syndicate."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "subdomain": {"type": "string"},
        },
        "required": ["subdomain"],
    },
}

STATUS = {
    "name": "sherwood_monitor_status",
    "description": (
        "Get the status of all monitored syndicates: pid, uptime, events seen, "
        "last event time, and recent stderr. Use to answer 'is my syndicate "
        "being watched?' or to debug a silent monitor."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}
```

- [ ] **Step 4: Write tool handlers**

Create `hermes-plugin/sherwood_monitor/tools.py`:

```python
"""LLM-callable tool handlers."""
from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from .supervisor import Supervisor

ToolHandler = Callable[[dict], Awaitable[str]]


def make_handlers(sup: Supervisor) -> dict[str, ToolHandler]:
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

    return {
        "sherwood_monitor_start": start,
        "sherwood_monitor_stop": stop,
        "sherwood_monitor_status": status,
    }
```

- [ ] **Step 5: Run tests**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_tools.py -v`
Expected: 5 passed

- [ ] **Step 6: Commit**

```bash
git add hermes-plugin/sherwood_monitor/schemas.py hermes-plugin/sherwood_monitor/tools.py hermes-plugin/tests/test_tools.py
git commit -m "feat(hermes-plugin): LLM tools (start/stop/status) with schemas"
```

---

## Task 16: Session lifecycle hooks + catch-up

**Files:**
- Create: `hermes-plugin/sherwood_monitor/hooks.py`
- Create: `hermes-plugin/tests/test_hooks.py`

`on_session_start` runs one-shot `sherwood session check <sub>` per monitored syndicate and injects a summary block. `on_session_end` calls `supervisor.stop_all()`.

- [ ] **Step 1: Write the failing test**

Create `hermes-plugin/tests/test_hooks.py`:

```python
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sherwood_monitor.config import Config
from sherwood_monitor.hooks import make_session_hooks, on_session_end_factory


@pytest.mark.asyncio
async def test_session_start_injects_catchup_summary(fixture):
    cfg = Config(sherwood_bin="sherwood", syndicates=["alpha"], auto_start=False)
    ctx = MagicMock()
    sup = MagicMock()
    sup.start = AsyncMock()

    payload = json.dumps(fixture("session_check_output"))

    async def fake_comm():
        return (payload.encode(), b"")

    proc = MagicMock()
    proc.communicate = AsyncMock(side_effect=[(payload.encode(), b"")])
    proc.wait = AsyncMock(return_value=0)

    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        hooks = make_session_hooks(cfg=cfg, ctx=ctx, supervisor=sup)
        await hooks["on_session_start"]()

    # Injected a catch-up summary referencing the syndicate
    assert any(
        "alpha" in call.kwargs.get("content", "")
        for call in ctx.inject_message.call_args_list
    )


@pytest.mark.asyncio
async def test_session_start_auto_starts_supervisors(fixture):
    cfg = Config(sherwood_bin="sherwood", syndicates=["alpha"], auto_start=True)
    ctx = MagicMock()
    sup = MagicMock()
    sup.start = AsyncMock()

    payload = json.dumps(
        {"syndicate": "alpha", "messages": [], "events": [], "meta": {"newMessages": 0, "newEvents": 0, "blocksScanned": 0, "lastCheckAt": "never"}}
    )
    proc = MagicMock()
    proc.communicate = AsyncMock(return_value=(payload.encode(), b""))
    proc.wait = AsyncMock(return_value=0)

    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        hooks = make_session_hooks(cfg=cfg, ctx=ctx, supervisor=sup)
        await hooks["on_session_start"]()

    sup.start.assert_awaited_once_with("alpha")


@pytest.mark.asyncio
async def test_session_end_stops_all():
    sup = MagicMock()
    sup.stop_all = AsyncMock()
    end = on_session_end_factory(sup)
    await end()
    sup.stop_all.assert_awaited_once()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_hooks.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `hermes-plugin/sherwood_monitor/hooks.py`:

```python
"""Hermes lifecycle hooks."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Awaitable, Callable

from .config import Config
from .supervisor import Supervisor

_log = logging.getLogger(__name__)


async def _catchup_one(sherwood_bin: str, subdomain: str) -> dict | None:
    try:
        proc = await asyncio.create_subprocess_exec(
            sherwood_bin,
            "session",
            "check",
            subdomain,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _stderr = await proc.communicate()
        if proc.returncode != 0:
            _log.warning("catch-up for %s exited rc=%s", subdomain, proc.returncode)
            return None
        return json.loads(stdout.decode("utf-8", "replace") or "{}")
    except Exception as exc:
        _log.warning("catch-up for %s failed: %s", subdomain, exc)
        return None


def _format_catchup_injection(subdomain: str, payload: dict) -> str:
    meta = payload.get("meta", {})
    new_msgs = meta.get("newMessages", 0)
    new_events = meta.get("newEvents", 0)
    return (
        f'<sherwood-catchup syndicate="{subdomain}">\n'
        f"{new_msgs} new messages, {new_events} new events since last check.\n"
        f"{json.dumps(payload, indent=2)}\n"
        f"</sherwood-catchup>"
    )


def make_session_hooks(
    cfg: Config, ctx: Any, supervisor: Supervisor
) -> dict[str, Callable[[], Awaitable[None]]]:
    async def on_session_start() -> None:
        for sub in cfg.syndicates:
            payload = await _catchup_one(cfg.sherwood_bin, sub)
            if payload is not None:
                ctx.inject_message(
                    content=_format_catchup_injection(sub, payload), role="user"
                )
            if cfg.auto_start:
                try:
                    await supervisor.start(sub)
                except Exception as exc:
                    _log.warning("auto-start failed for %s: %s", sub, exc)

    return {"on_session_start": on_session_start}


def on_session_end_factory(supervisor: Supervisor) -> Callable[[], Awaitable[None]]:
    async def on_session_end() -> None:
        await supervisor.stop_all()

    return on_session_end
```

- [ ] **Step 4: Run tests**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_hooks.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/hooks.py hermes-plugin/tests/test_hooks.py
git commit -m "feat(hermes-plugin): session_start catch-up + session_end cleanup"
```

---

## Task 17: Risk check module (Phase 2)

**Files:**
- Create: `hermes-plugin/sherwood_monitor/risk.py`
- Create: `hermes-plugin/tests/test_risk.py`

Pure functions that take a parsed Sherwood command (subdomain + params) and return `RiskVerdict(ok: bool, reason: str)`. Individual checks compose into `evaluate_propose()`.

Day 1 scope: three conservative checks that the spec named (portfolio exposure, mandate compliance, position sizing). Rules are intentionally simple and overridable via config in a later revision.

- [ ] **Step 1: Write the failing test**

Create `hermes-plugin/tests/test_risk.py`:

```python
import pytest

from sherwood_monitor.risk import (
    ProposeParams,
    RiskVerdict,
    check_mandate_compliance,
    check_portfolio_exposure,
    check_position_sizing,
    evaluate_propose,
)


def test_portfolio_exposure_ok():
    v = check_portfolio_exposure(proposed_size_usd=5_000, current_exposure_usd=10_000, vault_aum_usd=100_000)
    assert v.ok is True


def test_portfolio_exposure_blocks_when_total_over_50pct():
    v = check_portfolio_exposure(proposed_size_usd=50_000, current_exposure_usd=10_000, vault_aum_usd=100_000)
    assert v.ok is False
    assert "exposure" in v.reason.lower()


def test_mandate_compliance_ok():
    v = check_mandate_compliance(protocol="moonwell", allowed=["moonwell", "aerodrome"])
    assert v.ok is True


def test_mandate_compliance_blocks_unknown():
    v = check_mandate_compliance(protocol="unknown-defi", allowed=["moonwell"])
    assert v.ok is False
    assert "mandate" in v.reason.lower()


def test_position_sizing_ok():
    v = check_position_sizing(proposed_size_usd=5_000, vault_aum_usd=100_000)
    assert v.ok is True


def test_position_sizing_blocks_over_25pct_single_position():
    v = check_position_sizing(proposed_size_usd=30_000, vault_aum_usd=100_000)
    assert v.ok is False
    assert "position" in v.reason.lower()


def test_evaluate_propose_aggregates_checks():
    params = ProposeParams(
        subdomain="alpha",
        proposed_size_usd=30_000,
        current_exposure_usd=10_000,
        vault_aum_usd=100_000,
        protocol="moonwell",
        allowed_protocols=["moonwell"],
    )
    verdict = evaluate_propose(params)
    assert verdict.ok is False
    assert "position" in verdict.reason.lower()


def test_evaluate_propose_all_pass():
    params = ProposeParams(
        subdomain="alpha",
        proposed_size_usd=5_000,
        current_exposure_usd=10_000,
        vault_aum_usd=100_000,
        protocol="moonwell",
        allowed_protocols=["moonwell"],
    )
    verdict = evaluate_propose(params)
    assert verdict.ok is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_risk.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `hermes-plugin/sherwood_monitor/risk.py`:

```python
"""Conservative risk checks for agent-initiated Sherwood proposals."""
from __future__ import annotations

from dataclasses import dataclass, field

MAX_TOTAL_EXPOSURE_PCT = 0.50
MAX_SINGLE_POSITION_PCT = 0.25


@dataclass(frozen=True)
class RiskVerdict:
    ok: bool
    reason: str = ""


@dataclass(frozen=True)
class ProposeParams:
    subdomain: str
    proposed_size_usd: float
    current_exposure_usd: float
    vault_aum_usd: float
    protocol: str
    allowed_protocols: list[str] = field(default_factory=list)


def check_portfolio_exposure(
    proposed_size_usd: float,
    current_exposure_usd: float,
    vault_aum_usd: float,
) -> RiskVerdict:
    if vault_aum_usd <= 0:
        return RiskVerdict(False, "portfolio exposure: vault AUM is zero")
    total = proposed_size_usd + current_exposure_usd
    if total / vault_aum_usd > MAX_TOTAL_EXPOSURE_PCT:
        pct = int((total / vault_aum_usd) * 100)
        return RiskVerdict(
            False,
            f"portfolio exposure would reach {pct}% of AUM "
            f"(max {int(MAX_TOTAL_EXPOSURE_PCT * 100)}%)",
        )
    return RiskVerdict(True)


def check_mandate_compliance(protocol: str, allowed: list[str]) -> RiskVerdict:
    if not allowed:
        return RiskVerdict(True)  # no mandate configured = permissive
    if protocol.lower() not in {p.lower() for p in allowed}:
        return RiskVerdict(
            False,
            f"mandate compliance: protocol '{protocol}' not in allowed list {allowed}",
        )
    return RiskVerdict(True)


def check_position_sizing(
    proposed_size_usd: float, vault_aum_usd: float
) -> RiskVerdict:
    if vault_aum_usd <= 0:
        return RiskVerdict(False, "position sizing: vault AUM is zero")
    if proposed_size_usd / vault_aum_usd > MAX_SINGLE_POSITION_PCT:
        pct = int((proposed_size_usd / vault_aum_usd) * 100)
        return RiskVerdict(
            False,
            f"position sizing: single position at {pct}% of AUM "
            f"(max {int(MAX_SINGLE_POSITION_PCT * 100)}%)",
        )
    return RiskVerdict(True)


def evaluate_propose(params: ProposeParams) -> RiskVerdict:
    for verdict in (
        check_position_sizing(params.proposed_size_usd, params.vault_aum_usd),
        check_portfolio_exposure(
            params.proposed_size_usd,
            params.current_exposure_usd,
            params.vault_aum_usd,
        ),
        check_mandate_compliance(params.protocol, params.allowed_protocols),
    ):
        if not verdict.ok:
            return verdict
    return RiskVerdict(True)
```

- [ ] **Step 4: Run tests**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_risk.py -v`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/risk.py hermes-plugin/tests/test_risk.py
git commit -m "feat(hermes-plugin): risk check module with three conservative rules"
```

---

## Task 18: pre_tool_call hook with command parsing

**Files:**
- Modify: `hermes-plugin/sherwood_monitor/hooks.py`
- Modify: `hermes-plugin/tests/test_hooks.py`

Match command string via regex; if matched, extract subdomain + size, fetch current state via `sherwood proposal list --json` or similar, run risk checks.

Day 1 simplification: the pre_tool_call hook parses the *command* for `subdomain` and `--size-usd` style flags. When a richer state fetch is needed (exposure, AUM), it calls a `state_fetcher` callable injected at hook creation time. Day 1 provides a stub fetcher that returns safe defaults; real fetcher is plumbed in Task 22.

- [ ] **Step 1: Append failing tests**

Append to `hermes-plugin/tests/test_hooks.py`:

```python
from unittest.mock import AsyncMock

from sherwood_monitor.hooks import make_pre_tool_call_hook
from sherwood_monitor.risk import RiskVerdict


def _state_fetcher(result):
    async def fetch(sub):
        return result
    return fetch


@pytest.mark.asyncio
async def test_pre_tool_call_passes_through_non_sherwood_commands():
    fetch = _state_fetcher({"vault_aum_usd": 100_000, "current_exposure_usd": 0, "allowed_protocols": ["moonwell"]})
    hook = make_pre_tool_call_hook(state_fetcher=fetch)
    result = await hook(tool_name="bash", params={"command": "ls -la"})
    assert result is None


@pytest.mark.asyncio
async def test_pre_tool_call_passes_through_non_terminal_tools():
    fetch = _state_fetcher({"vault_aum_usd": 100_000, "current_exposure_usd": 0, "allowed_protocols": ["moonwell"]})
    hook = make_pre_tool_call_hook(state_fetcher=fetch)
    result = await hook(
        tool_name="web_search", params={"command": "sherwood proposal create alpha --size-usd 5000"}
    )
    assert result is None


@pytest.mark.asyncio
async def test_pre_tool_call_blocks_oversized_proposal():
    fetch = _state_fetcher({"vault_aum_usd": 100_000, "current_exposure_usd": 0, "allowed_protocols": ["moonwell"]})
    hook = make_pre_tool_call_hook(state_fetcher=fetch)
    result = await hook(
        tool_name="bash",
        params={
            "command": "sherwood proposal create alpha --size-usd 30000 --protocol moonwell"
        },
    )
    assert result == {"blocked": True, "reason": result["reason"]}
    assert "position" in result["reason"].lower()


@pytest.mark.asyncio
async def test_pre_tool_call_allows_compliant_proposal():
    fetch = _state_fetcher({"vault_aum_usd": 100_000, "current_exposure_usd": 0, "allowed_protocols": ["moonwell"]})
    hook = make_pre_tool_call_hook(state_fetcher=fetch)
    result = await hook(
        tool_name="bash",
        params={
            "command": "sherwood proposal create alpha --size-usd 5000 --protocol moonwell"
        },
    )
    assert result is None


@pytest.mark.asyncio
async def test_pre_tool_call_blocks_disallowed_protocol():
    fetch = _state_fetcher({"vault_aum_usd": 100_000, "current_exposure_usd": 0, "allowed_protocols": ["moonwell"]})
    hook = make_pre_tool_call_hook(state_fetcher=fetch)
    result = await hook(
        tool_name="bash",
        params={
            "command": "sherwood proposal create alpha --size-usd 5000 --protocol unknown"
        },
    )
    assert result is not None
    assert result["blocked"] is True
    assert "mandate" in result["reason"].lower()


@pytest.mark.asyncio
async def test_pre_tool_call_strategy_propose_pattern():
    fetch = _state_fetcher({"vault_aum_usd": 100_000, "current_exposure_usd": 0, "allowed_protocols": ["moonwell"]})
    hook = make_pre_tool_call_hook(state_fetcher=fetch)
    result = await hook(
        tool_name="terminal",
        params={
            "command": "sherwood strategy propose alpha --size-usd 5000 --protocol moonwell"
        },
    )
    assert result is None


@pytest.mark.asyncio
async def test_pre_tool_call_swallows_fetcher_exception():
    async def fetch(sub):
        raise RuntimeError("rpc down")

    hook = make_pre_tool_call_hook(state_fetcher=fetch)
    result = await hook(
        tool_name="bash",
        params={
            "command": "sherwood proposal create alpha --size-usd 5000 --protocol moonwell"
        },
    )
    # On fetcher error, pass through (don't block agent if we can't verify)
    assert result is None
```

- [ ] **Step 2: Run tests to verify failures**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_hooks.py -v`
Expected: 7 failures (all the pre_tool_call tests) + 3 passing (session hooks)

- [ ] **Step 3: Implement pre_tool_call hook**

Append to `hermes-plugin/sherwood_monitor/hooks.py`:

```python
import re
import shlex
from typing import Awaitable, Callable

from .risk import ProposeParams, evaluate_propose

# Match `sherwood proposal create <sub>` or `sherwood strategy propose <sub>`
_SHERWOOD_PROPOSE_RE = re.compile(
    r"\bsherwood\s+(?:strategy\s+propose|proposal\s+create)\s+(\S+)"
)
_TERMINAL_TOOLS = {"bash", "terminal", "shell"}

StateFetcher = Callable[[str], Awaitable[dict]]


def _parse_propose_command(command: str) -> tuple[str, float, str] | None:
    """Return (subdomain, size_usd, protocol) or None if not a propose command."""
    m = _SHERWOOD_PROPOSE_RE.search(command)
    if not m:
        return None
    subdomain = m.group(1)

    try:
        tokens = shlex.split(command)
    except ValueError:
        return None

    size_usd = 0.0
    protocol = ""
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok == "--size-usd" and i + 1 < len(tokens):
            try:
                size_usd = float(tokens[i + 1])
            except ValueError:
                pass
            i += 2
            continue
        if tok == "--protocol" and i + 1 < len(tokens):
            protocol = tokens[i + 1]
            i += 2
            continue
        i += 1

    return subdomain, size_usd, protocol


def make_pre_tool_call_hook(state_fetcher: StateFetcher):
    async def hook(tool_name: str = "", params: dict | None = None, **_: Any):
        if tool_name not in _TERMINAL_TOOLS:
            return None
        command = (params or {}).get("command", "")
        parsed = _parse_propose_command(command)
        if parsed is None:
            return None
        subdomain, size_usd, protocol = parsed

        try:
            state = await state_fetcher(subdomain)
        except Exception as exc:
            _log.warning("state fetch failed for %s: %s — allowing", subdomain, exc)
            return None

        verdict = evaluate_propose(
            ProposeParams(
                subdomain=subdomain,
                proposed_size_usd=size_usd,
                current_exposure_usd=float(state.get("current_exposure_usd", 0)),
                vault_aum_usd=float(state.get("vault_aum_usd", 0)),
                protocol=protocol,
                allowed_protocols=list(state.get("allowed_protocols", [])),
            )
        )
        if not verdict.ok:
            return {"blocked": True, "reason": verdict.reason}
        return None

    return hook
```

- [ ] **Step 4: Run tests**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_hooks.py -v`
Expected: 10 passed

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/hooks.py hermes-plugin/tests/test_hooks.py
git commit -m "feat(hermes-plugin): pre_tool_call hook with risk-check enforcement"
```

---

## Task 19: Memory writer + post_tool_call hook

**Files:**
- Create: `hermes-plugin/sherwood_monitor/memory.py`
- Create: `hermes-plugin/tests/test_memory.py`
- Modify: `hermes-plugin/sherwood_monitor/hooks.py`
- Modify: `hermes-plugin/tests/test_hooks.py`

Writes a memory record after successful `sherwood proposal execute` / `settle`. Memory goes through Hermes' memory API (accessed via `ctx.memory` or a passed-in writer function).

- [ ] **Step 1: Write the failing test for memory module**

Create `hermes-plugin/tests/test_memory.py`:

```python
import json
from unittest.mock import MagicMock

import pytest

from sherwood_monitor.memory import build_record, write_settlement


def test_build_record_execute():
    rec = build_record(
        subdomain="alpha",
        action="execute",
        command="sherwood proposal execute alpha 42",
        result_json='{"tx": "0xabc", "proposalId": 42}',
    )
    assert rec["syndicate"] == "alpha"
    assert rec["action"] == "execute"
    assert rec["tx_hash"] == "0xabc"
    assert rec["proposal_id"] == 42


def test_build_record_settle_with_pnl():
    rec = build_record(
        subdomain="alpha",
        action="settle",
        command="sherwood proposal settle alpha 42",
        result_json='{"tx": "0xdef", "proposalId": 42, "pnl": "1500000000"}',
    )
    assert rec["action"] == "settle"
    assert rec["pnl_usd"] == 1500.0


def test_build_record_handles_non_json_result():
    rec = build_record(
        subdomain="alpha",
        action="execute",
        command="sherwood proposal execute alpha 42",
        result_json="ok",
    )
    assert rec["syndicate"] == "alpha"
    assert rec["tx_hash"] is None


def test_write_settlement_calls_memory_writer():
    writer = MagicMock()
    write_settlement(
        writer,
        subdomain="alpha",
        action="settle",
        command="sherwood proposal settle alpha 42",
        result_json='{"tx": "0x1", "proposalId": 42}',
    )
    writer.assert_called_once()
    args = writer.call_args.args
    assert args[0]["syndicate"] == "alpha"
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_memory.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write memory module**

Create `hermes-plugin/sherwood_monitor/memory.py`:

```python
"""Build and write post-settlement memory records."""
from __future__ import annotations

import json
import re
import time
from typing import Any, Callable

MemoryWriter = Callable[[dict], None]

_PROPOSAL_ID_RE = re.compile(r"\b(\d+)\b")


def _parse_proposal_id(command: str) -> int | None:
    m = _PROPOSAL_ID_RE.search(command.split()[-1]) if command else None
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            return None
    return None


def build_record(
    *,
    subdomain: str,
    action: str,
    command: str,
    result_json: str,
) -> dict[str, Any]:
    tx_hash: str | None = None
    proposal_id: int | None = _parse_proposal_id(command)
    pnl_usd: float | None = None
    try:
        parsed = json.loads(result_json)
        if isinstance(parsed, dict):
            tx_hash = parsed.get("tx") or parsed.get("txHash")
            if parsed.get("proposalId"):
                try:
                    proposal_id = int(parsed["proposalId"])
                except (ValueError, TypeError):
                    pass
            pnl_raw = parsed.get("pnl")
            if pnl_raw is not None:
                try:
                    pnl_usd = float(pnl_raw) / 1_000_000
                except (ValueError, TypeError):
                    pnl_usd = None
    except (json.JSONDecodeError, TypeError):
        pass

    return {
        "syndicate": subdomain,
        "action": action,
        "timestamp": int(time.time()),
        "command": command,
        "tx_hash": tx_hash,
        "proposal_id": proposal_id,
        "pnl_usd": pnl_usd,
    }


def write_settlement(
    writer: MemoryWriter,
    *,
    subdomain: str,
    action: str,
    command: str,
    result_json: str,
) -> None:
    record = build_record(
        subdomain=subdomain, action=action, command=command, result_json=result_json
    )
    try:
        writer(record)
    except Exception:
        # Memory write failures must never affect agent behavior
        pass
```

- [ ] **Step 4: Run memory tests**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_memory.py -v`
Expected: 4 passed

- [ ] **Step 5: Write failing test for post_tool_call hook**

Append to `hermes-plugin/tests/test_hooks.py`:

```python
from sherwood_monitor.hooks import make_post_tool_call_hook


@pytest.mark.asyncio
async def test_post_tool_call_writes_memory_on_execute():
    writer = MagicMock()
    hook = make_post_tool_call_hook(memory_writer=writer)
    await hook(
        tool_name="bash",
        params={"command": "sherwood proposal execute alpha 42"},
        result='{"tx": "0xabc", "proposalId": 42}',
    )
    writer.assert_called_once()
    assert writer.call_args.args[0]["action"] == "execute"


@pytest.mark.asyncio
async def test_post_tool_call_writes_memory_on_settle():
    writer = MagicMock()
    hook = make_post_tool_call_hook(memory_writer=writer)
    await hook(
        tool_name="bash",
        params={"command": "sherwood proposal settle alpha 42"},
        result='{"tx": "0xdef", "proposalId": 42, "pnl": "500000000"}',
    )
    writer.assert_called_once()
    assert writer.call_args.args[0]["action"] == "settle"
    assert writer.call_args.args[0]["pnl_usd"] == 500.0


@pytest.mark.asyncio
async def test_post_tool_call_skips_other_commands():
    writer = MagicMock()
    hook = make_post_tool_call_hook(memory_writer=writer)
    await hook(
        tool_name="bash",
        params={"command": "ls -la"},
        result="total 0\n",
    )
    writer.assert_not_called()


@pytest.mark.asyncio
async def test_post_tool_call_swallows_writer_error():
    writer = MagicMock(side_effect=RuntimeError("oom"))
    hook = make_post_tool_call_hook(memory_writer=writer)
    # Must not raise
    await hook(
        tool_name="bash",
        params={"command": "sherwood proposal execute alpha 42"},
        result='{"tx": "0xabc"}',
    )
```

- [ ] **Step 6: Add post_tool_call hook**

Append to `hermes-plugin/sherwood_monitor/hooks.py`:

```python
from .memory import MemoryWriter, write_settlement

_SHERWOOD_SETTLE_RE = re.compile(
    r"\bsherwood\s+proposal\s+(execute|settle)\s+(\S+)"
)


def make_post_tool_call_hook(memory_writer: MemoryWriter):
    async def hook(
        tool_name: str = "",
        params: dict | None = None,
        result: Any = None,
        **_: Any,
    ):
        if tool_name not in _TERMINAL_TOOLS:
            return None
        command = (params or {}).get("command", "")
        m = _SHERWOOD_SETTLE_RE.search(command)
        if not m:
            return None
        action = m.group(1)
        subdomain = m.group(2)
        result_str = result if isinstance(result, str) else json.dumps(result)
        write_settlement(
            memory_writer,
            subdomain=subdomain,
            action=action,
            command=command,
            result_json=result_str,
        )
        return None

    return hook
```

- [ ] **Step 7: Run all hook tests**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_hooks.py -v`
Expected: 14 passed (10 previous + 4 new)

- [ ] **Step 8: Commit**

```bash
git add hermes-plugin/sherwood_monitor/memory.py hermes-plugin/sherwood_monitor/hooks.py hermes-plugin/tests/test_memory.py hermes-plugin/tests/test_hooks.py
git commit -m "feat(hermes-plugin): post_tool_call memory writer for execute/settle"
```

---

## Task 20: CLI commands

**Files:**
- Create: `hermes-plugin/sherwood_monitor/cli.py`

Thin wrappers around the tool handlers so humans can run `hermes sherwood status` etc. outside a conversation.

- [ ] **Step 1: Write implementation**

Create `hermes-plugin/sherwood_monitor/cli.py`:

```python
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
```

- [ ] **Step 2: Smoke test manually**

No unit test — this is a thin delegation layer. Covered by the Task 22 `register()` integration test.

- [ ] **Step 3: Commit**

```bash
git add hermes-plugin/sherwood_monitor/cli.py
git commit -m "feat(hermes-plugin): hermes sherwood <start|stop|status|tail> commands"
```

---

## Task 21: Default state fetcher and memory writer

**Files:**
- Create: `hermes-plugin/sherwood_monitor/state_fetcher.py`
- Create: `hermes-plugin/tests/test_state_fetcher.py`

Day-1 state fetcher shells out to `sherwood` to get vault info. For now, implement a safe stub that returns zeros — this means every propose command will be *allowed* by the risk checks unless the state is richer. We mark this as a known limitation documented for follow-up in the README.

Memory writer for day 1: print to stderr (no persistent memory API wiring until Hermes memory provider interface is confirmed).

- [ ] **Step 1: Write the failing test**

Create `hermes-plugin/tests/test_state_fetcher.py`:

```python
from unittest.mock import AsyncMock, patch

import pytest

from sherwood_monitor.state_fetcher import default_state_fetcher


@pytest.mark.asyncio
async def test_fetcher_returns_defaults_on_cli_error():
    with patch(
        "asyncio.create_subprocess_exec",
        AsyncMock(side_effect=FileNotFoundError),
    ):
        state = await default_state_fetcher("sherwood", "alpha")
    assert state == {
        "vault_aum_usd": 0.0,
        "current_exposure_usd": 0.0,
        "allowed_protocols": [],
    }


@pytest.mark.asyncio
async def test_fetcher_parses_valid_json():
    payload = b'{"aumUsd": "150000", "currentExposureUsd": "10000", "allowedProtocols": ["moonwell", "aerodrome"]}'
    proc = AsyncMock()
    proc.communicate = AsyncMock(return_value=(payload, b""))
    proc.wait = AsyncMock(return_value=0)
    proc.returncode = 0
    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        state = await default_state_fetcher("sherwood", "alpha")
    assert state["vault_aum_usd"] == 150_000
    assert state["current_exposure_usd"] == 10_000
    assert state["allowed_protocols"] == ["moonwell", "aerodrome"]
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_state_fetcher.py -v`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `hermes-plugin/sherwood_monitor/state_fetcher.py`:

```python
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


async def default_state_fetcher(sherwood_bin: str, subdomain: str) -> dict:
    defaults = {
        "vault_aum_usd": 0.0,
        "current_exposure_usd": 0.0,
        "allowed_protocols": [],
    }
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
            return defaults
        payload = json.loads(stdout.decode("utf-8", "replace") or "{}")
    except Exception as exc:
        _log.warning("state fetch failed for %s: %s", subdomain, exc)
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
```

- [ ] **Step 4: Run tests**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_state_fetcher.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
git add hermes-plugin/sherwood_monitor/state_fetcher.py hermes-plugin/tests/test_state_fetcher.py
git commit -m "feat(hermes-plugin): default state fetcher and stderr memory writer"
```

---

## Task 22: Plugin entry point — `register(ctx)`

**Files:**
- Modify: `hermes-plugin/sherwood_monitor/__init__.py`
- Create: `hermes-plugin/tests/test_register.py`

Wires every component together. This is the public API Hermes calls.

- [ ] **Step 1: Write the failing test**

Create `hermes-plugin/tests/test_register.py`:

```python
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


def test_register_calls_all_ctx_methods(tmp_path: Path, mock_ctx):
    (tmp_path / ".sherwood").mkdir()
    (tmp_path / ".sherwood" / "config.json").write_text("{}")

    fake_version = MagicMock(returncode=0, stdout="0.5.0")
    with patch("pathlib.Path.home", return_value=tmp_path), \
         patch("sherwood_monitor.preflight.subprocess.run", MagicMock(return_value=fake_version)):
        from sherwood_monitor import register
        register(mock_ctx)

    # 3 tools, 4 hooks (session_start, session_end, pre_tool_call, post_tool_call),
    # 4 CLI commands, 1 skill
    assert mock_ctx.register_tool.call_count == 3
    assert mock_ctx.register_hook.call_count == 4
    assert mock_ctx.register_cli_command.call_count == 4
    assert mock_ctx.register_skill.call_count == 1


def test_register_with_missing_cli_still_registers(tmp_path: Path, mock_ctx):
    with patch("pathlib.Path.home", return_value=tmp_path), \
         patch("sherwood_monitor.preflight.subprocess.run", MagicMock(side_effect=FileNotFoundError)):
        from sherwood_monitor import register
        register(mock_ctx)

    # Tools/hooks still register even when CLI is missing
    assert mock_ctx.register_tool.call_count == 3
    # A warning message was injected mentioning the install command
    assert mock_ctx.inject_message.call_count >= 1
    assert any(
        "npm i -g @sherwoodagent/cli" in call.kwargs.get("content", "")
        for call in mock_ctx.inject_message.call_args_list
    )
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_register.py -v`
Expected: FAIL — `register` not defined

- [ ] **Step 3: Write register()**

Replace `hermes-plugin/sherwood_monitor/__init__.py` with:

```python
"""sherwood-monitor Hermes plugin entry point."""
from __future__ import annotations

import logging
from functools import partial
from pathlib import Path
from typing import Any

from .cli import register_cli
from .config import load_config
from .hooks import (
    make_post_tool_call_hook,
    make_pre_tool_call_hook,
    make_session_hooks,
    on_session_end_factory,
)
from .preflight import run_preflight
from .router import EventRouter
from .schemas import START, STATUS, STOP
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

    # Preflight: warn if CLI missing/misconfigured, but continue registering
    pre = run_preflight(cfg.sherwood_bin)
    for warn in pre.warnings:
        ctx.inject_message(
            content=f"<sherwood-monitor-warning>\n{warn}\n</sherwood-monitor-warning>",
            role="user",
        )

    router = EventRouter(ctx=ctx, cfg=cfg, post_fn=post_summary)
    supervisor = Supervisor(cfg=cfg, router=router)

    tool_handlers = make_handlers(supervisor)
    ctx.register_tool(name=START["name"], schema=START, handler=tool_handlers["sherwood_monitor_start"])
    ctx.register_tool(name=STOP["name"], schema=STOP, handler=tool_handlers["sherwood_monitor_stop"])
    ctx.register_tool(name=STATUS["name"], schema=STATUS, handler=tool_handlers["sherwood_monitor_status"])

    session_hooks = make_session_hooks(cfg=cfg, ctx=ctx, supervisor=supervisor)
    ctx.register_hook("on_session_start", session_hooks["on_session_start"])
    ctx.register_hook("on_session_end", on_session_end_factory(supervisor))

    state_fetcher = partial(default_state_fetcher, cfg.sherwood_bin)
    ctx.register_hook("pre_tool_call", make_pre_tool_call_hook(state_fetcher=state_fetcher))
    ctx.register_hook("post_tool_call", make_post_tool_call_hook(memory_writer=stderr_memory_writer))

    register_cli(ctx, supervisor)

    skill_path = Path(__file__).parent.parent / "skills" / "sherwood-agent"
    if skill_path.exists():
        ctx.register_skill("sherwood-agent", str(skill_path))
    else:
        _log.warning("skill pack missing at %s — skipping", skill_path)
```

- [ ] **Step 4: Run tests**

Run: `cd hermes-plugin && .venv/bin/pytest tests/test_register.py -v`
Expected: 2 passed

- [ ] **Step 5: Full test suite**

Run: `cd hermes-plugin && .venv/bin/pytest -v`
Expected: all tests pass (~45 total)

- [ ] **Step 6: Commit**

```bash
git add hermes-plugin/sherwood_monitor/__init__.py hermes-plugin/tests/test_register.py
git commit -m "feat(hermes-plugin): register() entry point wires tools, hooks, CLI, skill"
```

---

## Task 23: BOOT.md

**Files:**
- Create: `hermes-plugin/BOOT.md`

- [ ] **Step 1: Write BOOT.md**

Create `hermes-plugin/BOOT.md`:

```markdown
# Sherwood Monitor — Boot

For each syndicate in `~/.hermes/plugins/sherwood-monitor/config.yaml`:

1. Call `sherwood_monitor_status()` and report each syndicate's state
   (`pid`, `uptime_seconds`, `events_seen`, `last_event_at`).
2. If `auto_start` is true and a syndicate has no live supervisor,
   call `sherwood_monitor_start(subdomain)`.
3. If `on_session_start` injected any `<sherwood-catchup>` blocks,
   summarize them briefly for the user (new proposals, settlements,
   risk alerts) so they know the state of their funds at session start.

If `sherwood_monitor_status()` returns an empty list, note that no
syndicates are configured and remind the user how to add one:
`edit ~/.hermes/plugins/sherwood-monitor/config.yaml`.
```

- [ ] **Step 2: Commit**

```bash
git add hermes-plugin/BOOT.md
git commit -m "docs(hermes-plugin): add BOOT.md startup routine"
```

---

## Task 24: Skill pack mirror

**Files:**
- Create: `hermes-plugin/scripts/refresh_skill_pack.sh`
- Create: `hermes-plugin/skills/sherwood-agent/*` (copied from `../skill/`)

- [ ] **Step 1: Write refresh script**

Create `hermes-plugin/scripts/refresh_skill_pack.sh`:

```bash
#!/usr/bin/env bash
# Mirror the sherwood skill pack into hermes-plugin/skills/sherwood-agent.
# Run from hermes-plugin/ directory.
set -euo pipefail

SRC="${1:-../skill}"
DEST="skills/sherwood-agent"

if [[ ! -d "$SRC" ]]; then
    echo "source not found: $SRC" >&2
    exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC"/* "$DEST"/
echo "skill pack mirrored from $SRC to $DEST"
```

- [ ] **Step 2: Make executable and run it**

```bash
chmod +x hermes-plugin/scripts/refresh_skill_pack.sh
cd hermes-plugin && ./scripts/refresh_skill_pack.sh
```

Expected: `skill pack mirrored from ../skill to skills/sherwood-agent`

- [ ] **Step 3: Verify files present**

Run: `ls hermes-plugin/skills/sherwood-agent/`
Expected: `SKILL.md ADDRESSES.md ERRORS.md GOVERNANCE.md RESEARCH.md skills/`

- [ ] **Step 4: Commit**

```bash
git add hermes-plugin/scripts/refresh_skill_pack.sh hermes-plugin/skills/
git commit -m "feat(hermes-plugin): bundle Sherwood skill pack via refresh script"
```

---

## Task 25: README

**Files:**
- Create: `hermes-plugin/README.md`

- [ ] **Step 1: Write README**

Create `hermes-plugin/README.md`:

````markdown
# sherwood-monitor — Hermes plugin

Turns Sherwood from "a CLI your agent can call" into an always-on fund
management system. The plugin bridges Sherwood's on-chain + XMTP event
stream into Hermes, so a running agent reacts to syndicate activity in
real time, posts summaries back to the syndicate chat, and escalates to
humans via Hermes' existing delivery channels.

## Prerequisites

- Hermes Agent installed
- Node.js 20+ and npm (for Sherwood CLI)
- Sherwood CLI installed globally: `npm i -g @sherwoodagent/cli`
- Sherwood CLI configured: `sherwood config set`

## Install

```bash
hermes plugins install imthatcarlos/sherwood-hermes-plugin
```

## Configure

Edit `~/.hermes/plugins/sherwood-monitor/config.yaml`:

```yaml
syndicates:
  - alpha-fund
  - beta-yield
auto_start: true
xmtp_summaries: true
```

## Usage

Start Hermes:

```bash
hermes
```

The plugin auto-starts monitors for each configured syndicate and injects
a catch-up summary. From chat:

- "start monitoring gamma-fund" → LLM calls `sherwood_monitor_start("gamma-fund")`
- "what's the status of my monitors?" → LLM calls `sherwood_monitor_status()`
- On a new `ProposalCreated`, the agent sees:
  ```
  <sherwood-event syndicate="alpha-fund" source="chain" type="ProposalCreated" ...>
  ```
  and can analyze + respond.

CLI outside chat:

```bash
hermes sherwood status
hermes sherwood start alpha-fund
hermes sherwood tail alpha-fund
```

## What the plugin does

| Event | Plugin behavior |
|---|---|
| On-chain `ProposalCreated` | Inject context + auto-post markdown summary to XMTP |
| On-chain `ProposalExecuted` / `ProposalSettled` / `ProposalCancelled` | Inject + XMTP summary |
| On-chain `VoteCast`, lifecycle events | Inject only (no XMTP post) |
| XMTP `RISK_ALERT` | Inject with `priority="high"` for agent escalation |
| XMTP `APPROVAL_REQUEST` | Inject with `priority="human-escalate"` |
| XMTP plain `MESSAGE` | Inject only when `@`-mention present (configurable) |
| Agent calls `sherwood proposal create/execute/settle` | `pre_tool_call` runs risk checks; `post_tool_call` writes memory |

## Risk checks

When the agent attempts `sherwood strategy propose` or `sherwood proposal create`,
the plugin blocks if any of these fail:

- Position size > 25% of vault AUM
- Total portfolio exposure > 50% of vault AUM
- Protocol not in the vault's configured mandate list

Day-1 limitation: the default state fetcher returns zeros when `sherwood vault info
--json` is unavailable, causing checks to fail-open (permissive). Configure
your mandate explicitly once `vault info` is fully wired.

## Development

```bash
cd hermes-plugin
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest -v
```

Refresh bundled skill pack from the Sherwood repo:

```bash
./scripts/refresh_skill_pack.sh ../skill
```

## License

MIT
````

- [ ] **Step 2: Commit**

```bash
git add hermes-plugin/README.md
git commit -m "docs(hermes-plugin): add README with install, config, usage"
```

---

## Task 26: Full test sweep + self-review

- [ ] **Step 1: Run the entire suite**

Run: `cd hermes-plugin && .venv/bin/pytest -v`
Expected: all tests pass, no skips, no warnings about asyncio patterns

- [ ] **Step 2: Manual import check**

Run:
```bash
cd hermes-plugin && .venv/bin/python -c "from sherwood_monitor import register; print('ok')"
```
Expected: `ok`

- [ ] **Step 3: Run pytest with coverage (optional but informative)**

Run:
```bash
cd hermes-plugin && .venv/bin/pip install pytest-cov && .venv/bin/pytest --cov=sherwood_monitor --cov-report=term-missing
```
Expected: most files 80%+ coverage. Files to spot-check if lower:
- `cli.py` (no unit tests, thin wrapper)
- `state_fetcher.py` (tests cover success + failure paths)

- [ ] **Step 4: Lint import sort + unused imports**

Run: `cd hermes-plugin && .venv/bin/python -m py_compile sherwood_monitor/*.py`
Expected: no errors

---

## Task 27: Migrate to standalone repo + submodule

**Goal:** move `hermes-plugin/` out of the Sherwood repo into a new GitHub repo `imthatcarlos/sherwood-hermes-plugin`, then add it back as a git submodule.

- [ ] **Step 1: Create the new repo on GitHub**

```bash
cd hermes-plugin
gh repo create imthatcarlos/sherwood-hermes-plugin \
  --public \
  --description "Hermes plugin for Sherwood syndicate monitoring" \
  --source=. \
  --remote=origin \
  --push=false
```

If the CLI is missing or auth fails, create the repo manually via github.com and set remote:
```bash
git remote add origin git@github.com:imthatcarlos/sherwood-hermes-plugin.git
```

- [ ] **Step 2: Initialize the new repo's history from the plugin directory**

```bash
cd hermes-plugin
git init
git add .
git commit -m "chore: initial commit — migrated from sherwood monorepo"
git branch -M main
git push -u origin main
```

- [ ] **Step 3: Remove `hermes-plugin/` from Sherwood and add as submodule**

From the Sherwood repo root:

```bash
cd ..
git rm -r hermes-plugin
git commit -m "chore: remove hermes-plugin in-place directory (moving to submodule)"
git submodule add git@github.com:imthatcarlos/sherwood-hermes-plugin.git hermes-plugin
git commit -m "chore: add hermes-plugin as submodule"
```

- [ ] **Step 4: Verify**

Run:
```bash
git submodule status
ls hermes-plugin/
cd hermes-plugin && git remote -v
```
Expected: submodule listed, plugin files present, remote points to the new GitHub repo.

- [ ] **Step 5: Update .gitmodules and CI**

Confirm `.gitmodules` contains:
```
[submodule "hermes-plugin"]
	path = hermes-plugin
	url = git@github.com:imthatcarlos/sherwood-hermes-plugin.git
```

No Sherwood CI changes needed — submodules are not recursively checked out in Sherwood's CI by default. Plugin repo gets its own CI in the next task (deferred; initial setup is a minimal GitHub Actions workflow and is out of scope for day 1).

- [ ] **Step 6: Push the Sherwood branch**

```bash
cd ..
git push -u origin feat/hermes-plugin-design
```

---

## Self-Review

After writing the plan, I checked against the spec:

**Spec coverage:**
- ✅ Repo layout → Task 1, Task 27
- ✅ Three components (Supervisor, EventRouter, plugin surface) → Tasks 11–14, 22
- ✅ `config.yaml` schema → Task 5
- ✅ Tools (start/stop/status) → Task 15
- ✅ Hooks (on_session_start/end, pre/post_tool_call) → Tasks 16, 18, 19
- ✅ CLI (`hermes sherwood …`) → Task 20
- ✅ Skill pack bundling + refresh script → Task 24
- ✅ BOOT.md → Task 23
- ✅ Event routing table (chain + XMTP) → Tasks 9, 10
- ✅ `<sherwood-event>` injection format → Task 9 (`_format_chain_injection`), Task 10 (`_format_xmtp_injection`)
- ✅ Subprocess supervisor with backoff + SIGTERM/SIGKILL → Tasks 12, 13, 14
- ✅ Risk checks (portfolio exposure, mandate compliance, position sizing) → Task 17
- ✅ Memory writes on execute/settle → Task 19
- ✅ Preflight → Task 6
- ✅ State file (plugin-local) → deferred to default auto-start behavior; config.yaml covers the "which syndicates" question. Added note: Task 22's `register()` uses `cfg.syndicates` directly, and `auto_start` drives initial spawns. No separate `state.json` needed day-1 — simplification noted.

**Placeholder scan:** None remain. All code steps have complete implementations. No TBD/TODO except the explicit day-1 limitation in `state_fetcher.py` (documented in README).

**Type consistency:**
- `PostFn`, `MemoryWriter`, `StateFetcher` type aliases used consistently
- `Config` fields match across config.py, tests, and handler signatures
- `RiskVerdict.ok` / `.reason` used consistently
- Handler signatures `(subdomain, record, ctx, cfg, post_fn)` consistent across chain + xmtp
- `build_record` output schema matches what tests assert

**Scope:** Phases 1+2 in one plan — 27 tasks, reasonable for one implementation pass. No decomposition needed.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-15-hermes-plugin.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for a 27-task plan so context doesn't blow up.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
