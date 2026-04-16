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
concentration_threshold_pct: 30.0
"""


@dataclass(frozen=True)
class Config:
    syndicates: list[str] = field(default_factory=list)
    auto_start: bool = False
    xmtp_summaries: bool = True
    sherwood_bin: str = "sherwood"
    backoff_max_seconds: int = 30
    inject_mentions_only: bool = True
    concentration_threshold_pct: float = 30.0


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
        concentration_threshold_pct=float(raw.get("concentration_threshold_pct", 30.0)),
    )
