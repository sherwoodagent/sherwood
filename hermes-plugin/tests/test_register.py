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
