# Publication intent – concurrency analysis (real PostgreSQL sessions)

Status: analysis of PostgreSQL READ COMMITTED semantics (Neon's default)
for commit `03067ee`. The PGlite tests run on one connection and only cover
serialized interleavings; the real two-session tests below are **planned,
not yet run** (no PostgreSQL server is available locally).

## Execution model

- The API uses the Neon HTTP driver: every statement is its own implicit
  transaction (autocommit, READ COMMITTED). No intent writer spans several
  statements in one transaction.
- Every automatic transition is ONE `UPDATE … WHERE <CAS>` statement. When
  two sessions update the same `listing_desired_states` row, the second one
  waits for the first one's row lock, then PostgreSQL re-evaluates the
  second statement's WHERE clause against the **newly committed row version**
  (EvalPlanQual). Predicates on the target row (`publication_intent_id`,
  `desired_publication_status`, `stock_auto_paused`, `stock_locked`,
  `auto_stock_sync`, `to_jsonb(d)`) are therefore always checked against the
  latest committed state.
- Correlated subqueries (`EXISTS` journal evidence, the latest journal event
  in the revert, the remote observation) are re-run for the new row version
  but with the statement's original snapshot: they do not see rows committed
  after the statement started.
- The guard trigger is `BEFORE UPDATE … FOR EACH ROW`: it runs after the row
  lock and the re-check, so `OLD` is the latest committed version.
- Every writer touches a single `listing_desired_states` row (plus inserts
  into `allegro_change_events`), so there is no lock-ordering deadlock.

## Manual decision vs. automatic transition

Manual writers (`savePublicationIntent`, ACCEPT, DISCARD, takeover) are
blind writes: they always win and always set a new intent id. Automatic
writers are CAS on the intent id they observed.

| Interleaving | Outcome |
|---|---|
| Manual commits, then automatic `beginAutomaticEndIntent` / `beginAutomaticActivateIntent` / `revertAutomaticEndIntent` / `confirmAutomaticEndOwnership` / ownership release | The automatic statement waits for or sees the new row; the re-check fails on `publication_intent_id` (or `to_jsonb(d)`) → 0 rows, no audit row. **Manual wins.** |
| Automatic commits, then manual | Manual overwrites with a new MANUAL intent (and `stock_auto_paused=false` for UI/takeover). Every later automatic CAS and confirmation for the old intent fails. **Manual wins.** |
| Manual commits while `beginAutomaticEndIntent` is running its "kept" (read-only) branch | The read uses the statement snapshot and may return the previous automatic id. Harmless: nothing is written; the following publication operation re-reads the row and acts on the current (manual) desired state with its own intent-version check before sending, and confirmation for the stale id fails. |
| Manual commits between the publication operation's last pre-send check and the PUT | One command for the previous intent is sent (pre-existing window of milliseconds, independent of 0029). It carries the old `intentId`, so it can never confirm ownership; the next operation sees it as the latest command and verifies it read-only before anything else. |

## Automatic vs. automatic

- Two inventory runs on the same account are excluded by the execution lease;
  two publication operations on the same listing by the publication lease.
- Even without them: the second `beginAutomaticEndIntent` re-checks
  `desired <> 'INACTIVE'` on the new row and returns no row; its "kept"
  branch read the old snapshot (desired ACTIVE) and returns nothing →
  `PUBLICATION_INTENT_CHANGED`, no command.
- Confirmation twice: the second re-check fails on `stock_auto_paused = false`
  → no second OWNERSHIP audit row.

## Unaware writers (previous version during rollback)

A same-value status write by the previous version takes the row lock; the
trigger compares with the latest committed version and clears the intent.
A concurrent confirmation either commits first (the old writer then clears
the intent and, for the UI writer, the pause) or re-checks after the old
writer and fails on the intent id. Fail closed in both orders.

## Finding C3 – revert vs. a command being created (low)

`revertAutomaticEndIntent` refuses while the latest `PUBLICATION_OPERATION`
journal event is unresolved, but that check uses the statement snapshot.
Sequence that defeats it:

1. Revert starts (snapshot without the new ATTEMPTED row).
2. A concurrent publication operation for the same listing (for example a UI
   "push status" on the pending row) commits ATTEMPTED and passes its last
   intent-version check.
3. Revert commits (desired ACTIVE).
4. The operation sends END.

Effect: an END for a superseded intent while desired is ACTIVE. The next run
reports `OWNERSHIP_UNRESOLVED` (remote ENDED, desired ACTIVE, not
auto-paused); the offer stays ended until an operator decides. No oversell
and no automatic ownership. The window is a few milliseconds and needs a
manual push-status on the same pending listing at the same moment.

Proposed fix (not implemented, needs approval): in the revert statement also
refuse while a live publication lease exists for the listing:

```sql
and not exists (
  select 1 from scheduler_leases l
  where l.name like 'allegro-publication:%:' || d.listing_id::text || ':%'
    and l.locked_until > now()
)
```

The operation acquires its lease well before ATTEMPTED (the lease commit, a
local read and a remote GET lie in between), so the revert statement can no
longer straddle the critical section.

## Planned real two-session tests

Harness: two independent connections (node-postgres `pg` as a dev
dependency) against `TEST_DATABASE_URL`, all migrations applied to an empty
database. Interleavings are forced, not timed: session A opens a transaction
and takes the row lock (its write or `SELECT … FOR UPDATE`), session B starts
its statement and is observed waiting in `pg_locks`, then A commits or rolls
back and B's result is asserted.

| # | A (holds the lock) | B (waits) | Expected |
|---|---|---|---|
| T1 | manual `savePublicationIntent` | `beginAutomaticEndIntent` (both orders) | MANUAL intent, no AUTOMATIC id |
| T2 | manual | `confirmAutomaticEndOwnership` | not paused, no OWNERSHIP audit |
| T3 | manual | `revertAutomaticEndIntent` | manual desired kept |
| T4 | manual | `beginAutomaticActivateIntent` | manual kept |
| T5 | `beginAutomaticEndIntent` | `beginAutomaticEndIntent` | one intent, second returns null |
| T6 | manual | ownership release (`reconcileStockOwnership`) | 0 rows |
| T7 | previous-version same-value write | `confirmAutomaticEndOwnership` (both orders) | never paused with an AUTOMATIC intent after the old write |
| T8 | ATTEMPTED insert (uncommitted) | `revertAutomaticEndIntent` | reproduces C3; passes after the lease fix |
| T9 | A rolls back instead of committing | each of T1–T6 | B applies as if A never ran |
| T10 | randomized: N sessions × M operations | — | invariants: no `stock_auto_paused` set without ALLEGRO_TASK_SUCCESS evidence for the current intent; every manual write committed last leaves a MANUAL intent; constraints never violated; no deadlock |

Environment options (each needs approval):

1. Local PostgreSQL (for example `winget install PostgreSQL.PostgreSQL.17`):
   system installation, no repository change besides the test harness.
2. `embedded-postgres` dev dependency: downloads PostgreSQL binaries at
   install time; no system installation.
3. A separate, empty Neon project (not a branch of production: a branch
   copies production data).
