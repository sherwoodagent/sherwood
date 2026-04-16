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

    # 5 tools, 5 hooks (session_start, session_end, pre_tool_call, post_tool_call, pre_llm_call),
    # 4 CLI commands, 1 skill
    assert mock_ctx.register_tool.call_count == 5
    assert mock_ctx.register_hook.call_count == 5
    assert mock_ctx.register_cli_command.call_count == 4
    assert mock_ctx.register_skill.call_count == 1


def test_register_with_missing_cli_still_registers(tmp_path: Path, mock_ctx):
    with patch("pathlib.Path.home", return_value=tmp_path), \
         patch("sherwood_monitor.preflight.subprocess.run", MagicMock(side_effect=FileNotFoundError)):
        from sherwood_monitor import register
        register(mock_ctx)

    # Tools/hooks still register even when CLI is missing
    assert mock_ctx.register_tool.call_count == 5
    # pre_llm_call hook was registered (buffer carries the warning now)
    hook_names = [call.args[0] for call in mock_ctx.register_hook.call_args_list]
    assert "pre_llm_call" in hook_names
