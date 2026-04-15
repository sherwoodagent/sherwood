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
TERMINATION_GRACE_SEC = 5.0

# Capture the real asyncio.sleep at import time so monkeypatches in tests
# (which target sherwood_monitor.supervisor.asyncio.sleep) don't break the
# pid-poll loop inside start().
_real_sleep = asyncio.sleep


@dataclass
class _State:
    subdomain: str
    proc: Any = None
    started_at: float = 0.0
    stop_requested: bool = False
    stderr_tail: deque[str] = field(default_factory=lambda: deque(maxlen=_STDERR_RING_SIZE))
    task: asyncio.Task | None = None
    exit_event: asyncio.Event = field(default_factory=asyncio.Event)
    # Fires each time _run_once completes (reset for next run); used by wait_until_exit.
    run_done_event: asyncio.Event = field(default_factory=asyncio.Event)


class Supervisor:
    def __init__(self, cfg: Config, router: EventRouter) -> None:
        self._cfg = cfg
        self._router = router
        self._states: dict[str, _State] = {}

    async def start(self, subdomain: str) -> int:
        """Spawn supervisor task for `subdomain`. Returns subprocess PID once available."""
        if subdomain in self._states:
            s = self._states[subdomain]
            if s.task and not s.task.done():
                return s.proc.pid if s.proc else 0

        state = _State(subdomain=subdomain)
        self._states[subdomain] = state
        state.task = asyncio.create_task(self._supervise(state), name=f"sherwood-{subdomain}")

        # Yield to let the task start and assign state.proc; avoid module-level asyncio.sleep
        # so tests that monkeypatch asyncio.sleep don't break this poll.
        for _ in range(50):
            if state.proc is not None:
                return state.proc.pid
            await _real_sleep(0.01)
        return 0

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

    async def stop_all(self) -> None:
        await asyncio.gather(
            *(self.stop(sub) for sub in list(self._states.keys())),
            return_exceptions=True,
        )

    async def wait_until_exit(self, subdomain: str) -> None:
        """Wait until the current subprocess run finishes (fires after each _run_once)."""
        state = self._states.get(subdomain)
        if state is None:
            return
        await state.run_done_event.wait()

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
        backoff = 1
        try:
            while not state.stop_requested:
                run_start = time.time()
                try:
                    await self._run_once(state)
                except Exception as exc:
                    _log.exception("subprocess run failed on %s: %s", state.subdomain, exc)
                finally:
                    # Signal that this run iteration completed; reset for the next.
                    state.run_done_event.set()
                    state.run_done_event = asyncio.Event()

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
                # Always yield one real tick so the event loop stays responsive
                # even when asyncio.sleep is monkeypatched in tests.
                await _real_sleep(0)
                backoff = min(self._cfg.backoff_max_seconds, backoff * 2)
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

        # Wait for the process to exit, then drain both stream readers naturally
        # (they exit when readline() returns b"" on EOF).  The gather with a
        # timeout lets stderr flush before we bail, which fixes a race where
        # proc.wait() returns immediately (e.g. in tests) and the tasks haven't
        # had a chance to run yet.
        await proc.wait()
        try:
            await asyncio.wait_for(asyncio.gather(stdout_task, stderr_task), timeout=2)
        except asyncio.TimeoutError:
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
