# Sherwood Monitor — Boot

For each syndicate in `~/.hermes/plugins/sherwood-monitor/config.yaml`:

1. Call `sherwood_monitor_status()` and report each syndicate's state
   (`pid`, `uptime_seconds`, `events_seen`, `last_event_at`).
2. If `auto_start` is true and a syndicate has no live supervisor,
   call `sherwood_monitor_start(subdomain)`.
3. If `on_session_start` injected any `<sherwood-catchup>` blocks,
   summarize them briefly for the user (new proposals, settlements,
   risk alerts) so they know the state of their funds at session start.

If `sherwood_monitor_status()` returns an empty list, note that no
syndicates are configured and remind the user how to add one:
`edit ~/.hermes/plugins/sherwood-monitor/config.yaml`.

## Cron setup (one-time)

If no `sherwood-monitor` cron is registered:
1. Call `cronjob(action="list")` to check.
2. If absent, call:
   ```
   cronjob(
     action="create",
     prompt="For each syndicate in ~/.hermes/plugins/sherwood-monitor/config.yaml, call sherwood_monitor_cron_tick(subdomain, include_exposure=true). Compose a concise digest of any returned events and concentration alerts. If all ticks returned empty events and no alerts, say nothing (deliver no message). Otherwise deliver the digest.",
     schedule="*/15 * * * *",
     name="sherwood-monitor"
   )
   ```
