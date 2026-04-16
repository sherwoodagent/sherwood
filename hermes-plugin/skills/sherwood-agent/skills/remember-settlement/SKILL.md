---
name: remember-settlement
description: Use immediately after observing any <sherwood-settlement> injection block. Persists institutional knowledge about strategy performance to agent memory.
---

# Remember settlement

When you see a `<sherwood-settlement>` block in the injected context, capture it in memory so you can reason about strategy performance over time.

## What to capture

From the block, extract: syndicate, strategy name, pnl_usd, duration_days, proposer, date.

## How to capture

Call the `memory` tool:

```
memory(
    action="add",
    content="Syndicate <sub> — strategy '<name>' settled <pnl_usd> over <duration_days>d on <date>. Proposer: <proposer>."
)
```

## When to skip

- The same settlement is already in memory (check with substring match on syndicate + strategy name + date).
- Memory is full — consolidate first via `memory(action="replace", ...)`.

## Why

Memory entries like these let you answer questions weeks later:
- "Has the Aerodrome LP strategy been profitable?"
- "What's the average P&L on 7-day strategies for alpha-fund?"
- "Which proposer has the best track record?"
