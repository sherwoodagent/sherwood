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
