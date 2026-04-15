---
name: sherwood-xmtp-checker
description: Read a Sherwood syndicate XMTP chat for new messages from other members and surface only direct asks or notable activity.
tags: [sherwood, xmtp, syndicate-chat, monitoring, cron]
triggers:
  - check sherwood xmtp messages
  - sherwood xmtp-checker cron
  - syndicate chat scan
---

# Sherwood XMTP Chat Checker

Pulls recent messages from a Sherwood syndicate XMTP group chat and
reports only on activity that needs attention.

The cron job invoking this skill MUST provide:
- `<SYNDICATE_NAME>` — XMTP chat identifier (e.g. `hyperliquid-algo`)
- `<CHAIN>` — chain alias (e.g. `hyperevm`)
- `<AGENT_WALLET>` — our wallet address (so we can skip our own messages)

## Procedure

### 1. Read recent messages

```bash
sherwood --chain <CHAIN> chat <SYNDICATE_NAME> log --limit 5
```

`sqlcipher` warnings in stderr are normal — ignore them.

### 2. Filter

For each message returned:
- Skip messages from `<AGENT_WALLET>` (these are reports we previously posted)
- Skip system events (`[MEMBER_JOIN]`, `[MEMBER_LEAVE]`, etc.)
- Skip the malformed `[undefined] ... undefined` placeholder messages

For the remaining messages from other members, classify:
- Direct ask / question to us → action required
- Action item (e.g. "please review proposal X") → action required
- General chatter → noise

### 3. Decision

If there are direct asks or action items:
- Summarize each briefly with sender address (last 4 chars), timestamp,
  and the gist
- Suggest a response or action

If there are only general chatter or no new messages from others, the
output is silent.

## Output policy (anomaly / action-only)

- **No new messages from others / only chatter** — respond with EXACTLY one line: `[SILENT]`
- **Action items present** — respond with `💬 CHAT ACTION:` followed by:
  - `From <addr>... at <time>: "<gist>". Suggested: <response or action>`

## Notification hook (if alerting)

If posting an acknowledgment back to chat, use `--stdin`:

```bash
printf '%s' 'Got it — looking into proposal #5 now.' \
  | sherwood --chain <CHAIN> chat <SYNDICATE_NAME> send --stdin
```

## Idempotency

Read-only. Re-running this skill within the same minute will return the
same set of messages. The skill does not mark messages as "read".
