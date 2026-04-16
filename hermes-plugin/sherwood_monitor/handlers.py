"""Per-event-type handlers: decide how to inject + whether to post to XMTP."""
from __future__ import annotations

import logging
from typing import Awaitable, Callable

from .config import Config
from .event_buffer import EventBuffer
from .models import ChainEvent, SessionMessage

_log = logging.getLogger(__name__)

PostFn = Callable[[str, str, str], Awaitable[None]]

# Events we inject as context but don't auto-post
CHAIN_INJECT_ONLY = {
    "VoteCast",
    "AgentRegistered",
    "AgentRemoved",
    "DepositorApproved",
    "DepositorRemoved",
    "RedemptionsLockedEvent",
    "RedemptionsUnlockedEvent",
    "Deposited",
    "Withdrawn",
}

# Events that inject AND auto-post a summary to XMTP
CHAIN_INJECT_AND_POST = {
    "ProposalCreated",
    "ProposalExecuted",
    "ProposalSettled",
    "ProposalCancelled",
}


def _format_chain_injection(subdomain: str, ev: ChainEvent, priority: str = "normal") -> str:
    args_lines = "\n".join(f"  {k}: {v}" for k, v in ev.args.items())
    return (
        f'<sherwood-event syndicate="{subdomain}" source="chain" '
        f'type="{ev.type}" priority="{priority}" block="{ev.block}" tx="{ev.tx}">\n'
        f"<args>\n{args_lines}\n</args>\n"
        f"</sherwood-event>"
    )


def _format_proposal_created_summary(ev: ChainEvent) -> str:
    name = ev.args.get("metadataName", "(unnamed)")
    desc = ev.args.get("metadataDescription", "")
    proposer = ev.args.get("proposer", "?")
    fee_bps = ev.args.get("performanceFeeBps", "?")
    duration = ev.args.get("strategyDuration", "?")
    try:
        duration_days = f"{int(duration) // 86400}d" if duration != "?" else "?"
    except ValueError:
        duration_days = "?"
    return (
        f"**Proposal #{ev.args.get('proposalId', '?')} — {name}**\n"
        f"{desc}\n"
        f"Proposer: `{proposer}` | Fee: {fee_bps} bps | Duration: {duration_days}"
    )


def _format_proposal_executed_summary(ev: ChainEvent) -> str:
    capital = ev.args.get("capitalSnapshot", "?")
    try:
        capital_usd = f"${int(capital) / 1_000_000:,.2f}"
    except ValueError:
        capital_usd = capital
    return (
        f"**Proposal #{ev.args.get('proposalId', '?')} executed** — "
        f"capital deployed: {capital_usd} (USDC)"
    )


def _format_proposal_settled_summary(ev: ChainEvent) -> str:
    pnl_raw = ev.args.get("pnl", "0")
    try:
        pnl_usd = f"${int(pnl_raw) / 1_000_000:+,.2f}"
    except ValueError:
        pnl_usd = pnl_raw
    duration = ev.args.get("duration", "?")
    try:
        duration_days = f"{int(duration) // 86400}d"
    except ValueError:
        duration_days = "?"
    return (
        f"**Proposal #{ev.args.get('proposalId', '?')} settled** — "
        f"pnl: {pnl_usd}, duration: {duration_days}"
    )


def _format_proposal_cancelled_summary(ev: ChainEvent) -> str:
    return (
        f"**Proposal #{ev.args.get('proposalId', '?')} cancelled** "
        f"by `{ev.args.get('cancelledBy', '?')}`"
    )


_CHAIN_SUMMARY_FORMATTERS: dict[str, Callable[[ChainEvent], str]] = {
    "ProposalCreated": _format_proposal_created_summary,
    "ProposalExecuted": _format_proposal_executed_summary,
    "ProposalSettled": _format_proposal_settled_summary,
    "ProposalCancelled": _format_proposal_cancelled_summary,
}


async def handle_chain_event(
    subdomain: str,
    ev: ChainEvent,
    buffer: EventBuffer,
    cfg: Config,
    post_fn: PostFn,
) -> None:
    """Route a single on-chain event."""
    if ev.type not in CHAIN_INJECT_ONLY and ev.type not in CHAIN_INJECT_AND_POST:
        _log.warning("unhandled chain event type: %s", ev.type)
        return

    buffer.push(_format_chain_injection(subdomain, ev))

    if ev.type in CHAIN_INJECT_AND_POST and cfg.xmtp_summaries:
        formatter = _CHAIN_SUMMARY_FORMATTERS.get(ev.type)
        if formatter is not None:
            summary = formatter(ev)
            await post_fn(cfg.sherwood_bin, subdomain, summary)


# XMTP message types that always get injected with specific priority
_XMTP_PRIORITY: dict[str, str] = {
    "RISK_ALERT": "high",
    "APPROVAL_REQUEST": "human-escalate",
    "STRATEGY_PROPOSAL": "normal",
    "TRADE_SIGNAL": "normal",
    "POSITION_UPDATE": "low",
    "LP_REPORT": "low",
    "TRADE_EXECUTED": "low",
    "MEMBER_JOIN": "low",
    "RAGEQUIT_NOTICE": "normal",
    "AGENT_REGISTERED": "low",
    "X402_RESEARCH": "normal",
}

# Types never injected regardless of config
_XMTP_NEVER_INJECT = {"REACTION"}


def _format_xmtp_injection(subdomain: str, msg: SessionMessage, priority: str) -> str:
    return (
        f'<sherwood-event syndicate="{subdomain}" source="xmtp" '
        f'type="{msg.type}" priority="{priority}" from="{msg.from_}" '
        f'sentAt="{msg.sent_at}">\n'
        f"{msg.text}\n"
        f"</sherwood-event>"
    )


async def handle_xmtp_message(
    subdomain: str,
    msg: SessionMessage,
    buffer: EventBuffer,
    cfg: Config,
    post_fn: PostFn,
) -> None:
    """Route a single XMTP message."""
    if msg.type in _XMTP_NEVER_INJECT:
        return

    # Plain MESSAGE: respect inject_mentions_only
    if msg.type == "MESSAGE":
        if cfg.inject_mentions_only and "@" not in msg.text:
            return
        buffer.push(_format_xmtp_injection(subdomain, msg, "normal"))
        return

    priority = _XMTP_PRIORITY.get(msg.type)
    if priority is None:
        _log.info("unhandled xmtp message type: %s", msg.type)
        return

    buffer.push(_format_xmtp_injection(subdomain, msg, priority))
