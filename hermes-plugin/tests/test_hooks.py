import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sherwood_monitor.config import Config
from sherwood_monitor.event_buffer import EventBuffer
from sherwood_monitor.hooks import make_session_hooks, on_session_end_factory


@pytest.mark.asyncio
async def test_session_start_injects_catchup_summary(fixture):
    cfg = Config(sherwood_bin="sherwood", syndicates=["alpha"], auto_start=False)
    buffer = MagicMock(spec=EventBuffer)
    sup = MagicMock()
    sup.start = AsyncMock()

    payload = json.dumps(fixture("session_check_output"))

    proc = MagicMock()
    proc.communicate = AsyncMock(side_effect=[(payload.encode(), b"")])
    proc.wait = AsyncMock(return_value=0)

    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        hooks = make_session_hooks(cfg=cfg, buffer=buffer, supervisor=sup)
        await hooks["on_session_start"]()

    # Pushed a catch-up summary referencing the syndicate
    assert any(
        "alpha" in call.args[0]
        for call in buffer.push.call_args_list
    )


@pytest.mark.asyncio
async def test_session_start_auto_starts_supervisors(fixture):
    cfg = Config(sherwood_bin="sherwood", syndicates=["alpha"], auto_start=True)
    buffer = MagicMock(spec=EventBuffer)
    sup = MagicMock()
    sup.start = AsyncMock()

    payload = json.dumps(
        {"syndicate": "alpha", "messages": [], "events": [], "meta": {"newMessages": 0, "newEvents": 0, "blocksScanned": 0, "lastCheckAt": "never"}}
    )
    proc = MagicMock()
    proc.communicate = AsyncMock(return_value=(payload.encode(), b""))
    proc.wait = AsyncMock(return_value=0)

    with patch("asyncio.create_subprocess_exec", AsyncMock(return_value=proc)):
        hooks = make_session_hooks(cfg=cfg, buffer=buffer, supervisor=sup)
        await hooks["on_session_start"]()

    sup.start.assert_awaited_once_with("alpha")


@pytest.mark.asyncio
async def test_session_end_stops_all():
    sup = MagicMock()
    sup.stop_all = AsyncMock()
    end = on_session_end_factory(sup)
    await end()
    sup.stop_all.assert_awaited_once()


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


from sherwood_monitor.hooks import make_pre_llm_call_hook


@pytest.mark.asyncio
async def test_pre_llm_call_drains_buffer_and_returns_context():
    buf = EventBuffer()
    buf.push("<a>1</a>")
    buf.push("<b>2</b>")
    hook = make_pre_llm_call_hook(buf)
    result = await hook(session_id="s1", user_message="hi")
    assert result == {"context": "<a>1</a>\n\n<b>2</b>"}
    assert len(buf) == 0


@pytest.mark.asyncio
async def test_pre_llm_call_returns_none_when_empty():
    hook = make_pre_llm_call_hook(EventBuffer())
    result = await hook(session_id="s1")
    assert result is None
