"""EventRouter: decode a raw record and dispatch to the right handler."""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from typing import Any

from .config import Config
from .event_buffer import EventBuffer
from .handlers import PostFn, handle_chain_event, handle_xmtp_message
from .models import ChainEvent, SessionMessage, decode_record

_log = logging.getLogger(__name__)


class EventRouter:
    def __init__(self, buffer: EventBuffer, cfg: Config, post_fn: PostFn) -> None:
        self._buffer = buffer
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
                await handle_chain_event(subdomain, rec, self._buffer, self._cfg, self._post_fn)
            elif isinstance(rec, SessionMessage):
                await handle_xmtp_message(subdomain, rec, self._buffer, self._cfg, self._post_fn)
        except Exception as exc:
            _log.exception("handler error on %s: %s", subdomain, exc)

    def events_seen(self, subdomain: str) -> int:
        return self._events_seen.get(subdomain, 0)

    def last_event_at(self, subdomain: str) -> float | None:
        return self._last_event_at.get(subdomain)
