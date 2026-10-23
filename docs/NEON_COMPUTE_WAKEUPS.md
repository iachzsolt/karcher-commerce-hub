# Compute wake reduction

## Implemented boundaries

- History liveness uses the newest inventory SYNC state per listing/source,
  isolating explicit command IDs. Display batch IDs are not command identities:
  reconciliation confirmations can omit the batch ID. Equal-time ambiguous
  states remain active conservatively. Persisted RUNNING wrappers remain active.
- The latest-run widget reads once when visible, polls only PENDING/RUNNING,
  cancels its timer when hidden, and refreshes once on becoming visible even
  after a terminal result. It has one timer and one in-flight read.
- Primary Allegro session restoration is deferred until an authenticated primary
  Allegro route or cron callback needs it. Concurrent initialization is shared;
  failed/unavailable restoration is retryable. Configuration validation remains
  fail-closed at Deno startup. Notification and health handlers do not request
  primary-session initialization.

## Remaining startup wakeup — intentionally retained

`deno.ts` still awaits `registerDataConnectionSchedulerCrons()` at module scope.
It queries database-configured DAILY_TIMES before registering the corresponding
UTC+1/UTC+2 candidates. Dropping the await, hardcoding 13:00, or adding an hourly
fallback would risk registration/timing changes. A future DB-free registration
requires an explicitly deployment-managed schedule manifest that is verified
against the database whenever enabled schedules change. The current database
schedule remains authoritative; no cron, lease, timezone or retry logic changed.

Thus a notification-only or health **cold start still queries Neon for scheduler
registration**, although those handlers and their primary-session path do not.
Warm-instance notification/health requests do not query Neon directly.

## Operational checks before claiming a billing outcome

- Verify Neon endpoint min/max CU, autosuspend delay, active-time graph and all
  branches. At 0.25 CU, 1.5 CU-hours/day permits only six active hours/day.
- Check Deno cold-start counts and scheduled-job outcomes. A cold start every ten
  minutes with a five-minute idle tail can consume about 3 CU-hours/day at 0.25 CU.
- Check PriceKit/Apps Script triggers and uptime monitors outside this repository.
  Use `/health` rather than `/database/health` for non-database availability checks,
  while accounting for the remaining cold-start registration query.
- Keep local `COMMERCE_HUB_SCHEDULERS_ENABLED` off unless deliberately running
  automation. Its explicit opt-in is not an environment/account isolation guard.
- HomePage freshness still performs bounded reads for eligible stale mismatches,
  auto-pause ownership checks, and inactive observations older than 15 minutes.
  An idle browser with those candidates can still query Neon. Partial merges
  remain unsupported by the reconciliation response contract.
- Do not infer runtime death from a stale RUNNING row alone, or mark it terminal
  merely to stop polling. Existing reaping happens when a newer same-connection
  wrapper finalizes and the older run exceeds the threshold.

No schema migration, deployment, production sync, or manual reaping is part of
this change. API and web deployment are both needed to activate it.
