"""JSON schemas for LLM-callable tools."""
from __future__ import annotations

START = {
    "name": "sherwood_monitor_start",
    "description": (
        "Start monitoring a Sherwood syndicate. Spawns a streaming subprocess "
        "that forwards on-chain events and XMTP messages into this conversation. "
        "Use this when the user asks to watch a new syndicate or after adding "
        "one to the config."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "subdomain": {
                "type": "string",
                "description": "Sherwood syndicate subdomain, e.g. 'alpha-fund'",
            }
        },
        "required": ["subdomain"],
    },
}

STOP = {
    "name": "sherwood_monitor_stop",
    "description": (
        "Stop monitoring a Sherwood syndicate. Terminates the streaming "
        "subprocess. Use when the user wants to stop receiving events from "
        "a syndicate."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "subdomain": {"type": "string"},
        },
        "required": ["subdomain"],
    },
}

STATUS = {
    "name": "sherwood_monitor_status",
    "description": (
        "Get the status of all monitored syndicates: pid, uptime, events seen, "
        "last event time, and recent stderr. Use to answer 'is my syndicate "
        "being watched?' or to debug a silent monitor."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

EXPOSURE = {
    "name": "sherwood_monitor_exposure",
    "description": (
        "Aggregate exposure across all configured syndicates. Returns total "
        "AUM, per-protocol breakdown, concentration percentages, and any "
        "concentration alerts above the configured threshold. Use this to "
        "answer questions like 'what\u2019s my total Aerodrome exposure?' or "
        "'which protocols am I over-exposed to?'"
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

CRON_TICK = {
    "name": "sherwood_monitor_cron_tick",
    "description": (
        "Autonomous tick: catch new interesting events for a syndicate since "
        "the last tick (ProposalCreated/Settled/Cancelled/Executed, RISK_ALERT, "
        "APPROVAL_REQUEST). Updates the tick cursor. Pass include_exposure=true "
        "to also compute concentration alerts. Used by the plugin's cron job to "
        "deliver digests via Hermes' gateway (Telegram/Discord). Returns empty "
        "events list when nothing interesting happened \u2014 that's the normal case."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "subdomain": {"type": "string"},
            "include_exposure": {"type": "boolean", "default": False},
        },
        "required": ["subdomain"],
    },
}
