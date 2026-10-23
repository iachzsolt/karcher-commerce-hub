# Bounded History fast polling

`hasActiveHistoryRows` remains the unresolved-state predicate. The separate
`hasFastPollEligibleHistoryWork` controls request frequency, not historical truth.

- SYNC PENDING / REACTIVATION_IN_PROGRESS: 60-second polling for **15 minutes**
  after the unresolved event's authoritative `occurredAt`.
- RUNNING catalog/inventory wrappers: 60-second polling for **60 minutes** after
  `startedAt`. Production inventory wrappers have legitimately taken ~55 minutes;
  stopping at 15 minutes would hide automatic completion updates for those runs.
- These tables have no heartbeat/update timestamp. Browser receipt time, an empty
  response, or another listing's activity does not renew a row's eligibility.
- The exact expiry boundary stops fast polling. Invalid/future timestamps do not
  authorize a recurring timer. This never changes the unresolved/display status.
- Stale-only history creates no recurring timer. Hidden tabs create no recurring
  requests. A hidden-to-visible transition refreshes once, with no overlap or
  deferred queue. Manual **Frissítés** always uses the full-load path.
- Real newer activity can resume fast polling when observed by manual/visibility
  refresh. A continuously visible stale-only page deliberately does not discover
  new external work automatically. This is a refresh policy, not evidence that
  external work has stopped or completed.

For the observed two ~23-hour RUNNING wrappers and 89 old STOCK_UPDATE/PENDING
records, History remains truthful but generates **zero recurring 60-second DB
requests**. This does not remove other tabs', integrations', or startup DB reads.

## Future durable wrapper recovery — design only

Current recovery (`reapStaleDataConnectionRuns`) requires a newer same-connection
wrapper to finalize. The scheduler's short `minute-scheduler` lease is not a
wrapper heartbeat: it is not renewed for the entire wrapper and is not durably
linked to its run ID. An expired scheduler lease cannot prove a runtime is gone.
Per-offer publication leases/journals do not cover stock batches or source import.
None of these proves that the two legacy wrapper owners have terminated.

Smallest viable future ownership design, potentially reusing `scheduler_leases`:

1. Bind a renewable execution lease to the exact connection/run/owner; persist the
   run identity in the key or a durable existing metadata contract. Lease creation
   and wrapper creation must have a crash-safe association.
2. Renew throughout the operation and fence **all** source/automation stages:
   assert live ownership before each side effect and stop a lost owner. Bound
   external calls; lease expiry alone cannot cancel an already-submitted request.
3. Recovery can execute on an existing maintenance invocation, independently of a
   newer run. Acquire recovery ownership atomically only after the worker lease
   expired plus an allowance for bounded in-flight calls. Reconcile unknown remote
   commands rather than assuming expiry means those commands failed.
4. Conditionally mark only the matching, still-RUNNING, ownership-fenced wrapper
   INTERRUPTED. Repeated recovery must be a no-op. Normal finalization and the
   existing reaper must use compatible ownership checks so they cannot clobber a
   successor or interrupt a live lease holder.
5. Legacy runs without this evidence remain operator-review cases. Do not turn
   "older than 30 minutes" or "no lease row" into proof of termination.

This needs a separately reviewed lifecycle change across writers/finalizers;
it is deliberately **not implemented** as part of frontend polling efficiency.

## Future stale SYNC reconciliation — design only

Existing `reconcilePendingSyncEvent` compares a STOCK_UPDATE's captured
`toStock` (fallback `targetStock`) with observed `remoteStock`. Equality can
produce an append-only SUCCESS event with `reconciled`, `supersedesOccurredAt`,
and `confirmedRemoteStock`. It does not prove which actor caused convergence.
`reconcileOpenPendingSyncEvents` currently uses resolved/cached remote rows and
only considers the newest SYNC event per listing; a history page read does not
invoke it.

A controlled recovery should first capture exact event/listing/offer/account and
intended target, then GET authoritative Allegro stock/publication with bounded
reads. Recheck mapping and latest-operation/intent state afterward. Compare to the
**captured operation target**, not a subsequently edited desired quantity. If
converged and still the same unresolved operation, append the existing evidence
format; otherwise retain unresolved state (including timeout/404/unknown data).
Stock convergence must not invent publication success, and current stock changes
must not be pushed as part of this verification. Use serialized/conditional
append semantics for concurrent recovery, since the existing read-then-insert
sequence alone is not an atomic concurrency guarantee. Preserve locks, manual
INACTIVE intent, campaign ownership and duplicate guards.

No production observation persistence, reconciliation, status changes, schema
changes, or Allegro writes were performed for this task.
