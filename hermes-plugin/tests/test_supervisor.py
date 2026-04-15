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
