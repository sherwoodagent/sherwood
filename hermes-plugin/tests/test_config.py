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
concentration_threshold_pct: 25.0
""".strip()
    )
    cfg = load_config(cfg_path)
    assert cfg.syndicates == ["alpha", "beta"]
    assert cfg.auto_start is True
    assert cfg.xmtp_summaries is False
    assert cfg.sherwood_bin == "/usr/local/bin/sherwood"
    assert cfg.backoff_max_seconds == 60
    assert cfg.inject_mentions_only is False
    assert cfg.concentration_threshold_pct == 25.0


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


def test_load_default_concentration_threshold(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    cfg = load_config(cfg_path)
    assert cfg.concentration_threshold_pct == 30.0
