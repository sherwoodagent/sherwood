import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sherwood_monitor.xmtp_post import post_summary


@pytest.mark.asyncio
async def test_post_summary_spawns_subprocess():
    mock_proc = MagicMock()
    mock_proc.communicate = AsyncMock(return_value=(b"", b""))
    mock_proc.returncode = 0
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
    mock_proc.communicate = AsyncMock(return_value=(b"", b"error"))
    mock_proc.returncode = 1
    mock_create = AsyncMock(return_value=mock_proc)
    with patch("asyncio.create_subprocess_exec", mock_create):
        await post_summary("sherwood", "alpha-fund", "hi")
    assert any("xmtp post failed" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_post_summary_drains_stdout_on_success():
    """Regression: proc.wait() before communicate() can deadlock if stdout
    exceeds the OS pipe buffer (~64KB). Ensure we always drain via communicate()."""
    big_stdout = b"x" * (128 * 1024)  # 128KB — past typical pipe buffer
    mock_proc = MagicMock()
    mock_proc.communicate = AsyncMock(return_value=(big_stdout, b""))
    mock_proc.returncode = 0
    mock_create = AsyncMock(return_value=mock_proc)
    with patch("asyncio.create_subprocess_exec", mock_create):
        await post_summary("sherwood", "alpha-fund", "hi")
    mock_proc.communicate.assert_awaited_once()
