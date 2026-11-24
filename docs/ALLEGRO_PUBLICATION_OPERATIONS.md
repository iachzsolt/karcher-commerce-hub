# Guarded Allegro publication operations

## Scope and rollout

All explicit publication commands in this repository are dispatched by
`executeAllegroPublicationTarget` through `executePublicationOperation`.
The existing `POST /auth/allegro/push-status/:listingId` route delegates to it;
row sync, bulk sync and inventory automation already use that route. A future
approved one-time runner can call the same function with an exact target and
`{ confirm: true, expectedIntentVersion }` remediation options. No new public
remediation endpoint or automatic END job has been added.

**Local implementation is not a production rollout.** Old deployed writers do
not honor these leases. A production remediation must wait for approval and a
guarded-writer rollout (or an explicitly controlled quiescent environment).
Never assume a newly created local-script lease protects against old production
writers. The ten-offer audit manifest remains the fixed remediation scope;
matching and 404 offers must not be added.

## Durable lease and command journal (no migration)

Existing `scheduler_leases` holds:

`allegro-publication:<accountId>:<listingId>:<offerId>`

- Atomic INSERT / conditional conflict UPDATE, only when the old lease expired.
- Unique owner UUID and **120-second TTL**, using the database clock.
- Ownership assertion/renewal before each bounded remote call and before send.
- Renewal cannot reclaim an expired lease; that holder must stop.
- Owner-qualified deletion in `finally`, including failure/timeout paths.
- Expiry recovers a killed runtime or failed release; another listing is independent.

Lease release after timeout must not authorize another publication command.
Append-only `allegro_change_events` records command IDs before dispatch:
ATTEMPTED, PENDING, SUCCESS, FAILED, or CANCELLED_BEFORE_SEND. Any nonterminal or
unknown command state is recovered by GET/polling the existing command, never
blindly resubmitted. Ambiguous network/server responses retain the command ID.
Recorded legacy inventory publication PENDING/in-progress results also block a
new dispatch; they are not treated as evidence that no operation is running.
An indefinitely unverifiable command needs operator investigation, not automatic
redispatch; the database lease itself is still recoverable and is not a permanent
lock. Existing pre-rollout commands have no retrospective journal.

## Execution and safety

Local account/environment/marketplace scope, exact listing/offer mapping and the
complete desired-state intent snapshot are rechecked. Remediation is END-only
and also rejects inactive products, duplicate SKUs, fresh UI changes and any
unresolved local campaign ownership. Remote badges must be absent or terminal.
After that badge read, remediation performs another authoritative offer GET
before dispatch; an already-ended offer is an ALREADY_FIXED no-op.

Normal explicit actions retain the existing campaign/business decision flow;
strict remediation adds campaign exclusions without editing any campaign state.
All existing Allegro environment/write-safety guards remain in place.

Fresh (<15 minutes) matching publication observations may short-circuit only
without unresolved journal work. Stale matching snapshots require authoritative
GET, so cached ENDED/INACTIVE can no longer conceal a live ACTIVE offer from an
explicit END. Existing ACTIVATING state does not cause duplicate ACTIVATE.

Exactly one publication PUT is submitted. Verification uses at most six
authoritative observations with five-second waits; each remote request has a
ten-second timeout (network/DB time is additional). Task status alone is not
successful publication verification. Outcomes: FIXED, ALREADY_FIXED,
PENDING_TIMEOUT, FAILED, SKIPPED_SAFETY, REMOTE_UNAVAILABLE.

## Local persistence and audit

The publication-only persister updates only remote `publication_status` and
`updated_at` from an actual offer GET. It does not change stock, price, locks,
auto-pause, desired intent, schedules, or campaigns. Full-observation
`last_synced_at` is intentionally not advanced: stock/price were not persisted.
The listing response exposes `publicationObservedAt` separately for freshness.

Detected cached-inactive → authoritative-ACTIVE transitions with desired INACTIVE
produce an atomic EXTERNAL_REACTIVATION audit event. This identifies a divergence,
not the actor that caused it. Publication intent saves now record old/new intent
atomically with their existing explicit-user takeover behavior. The pre-existing
manual intent action still clears auto-pause; remediation never invokes it.

Audit kinds distinguish intent saved, write attempted, authoritative already-match,
fresh cached-match, pending, success, failure, safety skips, and external
reactivation. Command events include account, offer and command IDs. They use the
existing change-event retention policy; no permanent campaign/history rewrite.

## Background freshness

The offers page also selects apparently compliant inactive listings with publication
observations at least 15 minutes old. It retains the existing five-candidate/minute
limit, per-listing cooldown and foreground-operation exclusions. New compliant
inactive reads use `publicationOnly: true` on `/reconcile-listings`, take the same
publication lease, and persist publication only. No END is sent from freshness.
There is no full-catalog scan on every page load. A row refresh remains available
for these stale apparently compliant rows.

## Verification boundary

Tests use fake remote adapters and lease stores; SQL tests inspect the production
guards and allowed columns. SQL planning can be checked with EXPLAIN (never
EXPLAIN ANALYZE). No live END is necessary to validate the code. Production
revalidation before approval consists only of SELECT and direct Allegro GETs;
it must not acquire a production lease, call sync/reconciliation routes, or
persist observations.

## Durable publication intent and auto-pause ownership (migration 0029)

`listing_desired_states` stores who decided the current publication intent:
`publication_intent_source` (`AUTOMATIC` | `MANUAL` | `NULL`),
`publication_intent_id` and `publication_intent_at`. A CHECK constraint allows
only those values and requires all three to be set together or all NULL.
`updated_by` is not ownership evidence: the inventory desired-stock writer
overwrites it on every run.

Writers:

| Writer | Intent |
|---|---|
| Inventory END (`beginAutomaticEndIntent`) | `AUTOMATIC`, CAS; a pending automatic END keeps its id |
| Inventory reactivation (`beginAutomaticActivateIntent`) | `AUTOMATIC`, CAS |
| Revert of a never-effective automatic END | new `AUTOMATIC` (ACTIVE), CAS, refused while a command is unresolved |
| Ownership confirmation / ownership release | keeps the intent (advances `publication_intent_at`) |
| Repeated pending automatic END / activation | keeps id and time: a read, not a write |
| `savePublicationIntent` (UI) | always a new `MANUAL`, also for the same status |
| ACCEPT (publication changed), DISCARD (publication changed), stock-edit takeover | new `MANUAL` |
| Stock-only, price-only, lock and automation toggles, stock-/price-only DISCARD | untouched (they do not write the status column) |
| Any other writer that writes `desired_publication_status` or `stock_auto_paused` (even with the same value) without a new intent | trigger clears the intent to `NULL` (fail closed) |

The guard trigger is `BEFORE UPDATE OF desired_publication_status,
stock_auto_paused`: it fires whenever an UPDATE lists one of these columns, also
for an unchanged value, so a same-value manual decision by an unaware writer
(for example the previous application version after a rollback) can never leave
an automatic intent in place.

Ownership classes: `CONFIRMED_AUTOMATIC` (auto-paused, AUTOMATIC intent),
`LEGACY_AUTO_PAUSED` (auto-paused, no intent: previous behavior, no new
privileges), `PENDING_AUTOMATIC` (desired INACTIVE by an AUTOMATIC intent, not
yet proven), `MANUAL`, `UNRESOLVED` (desired INACTIVE without intent; treated
like manual and never claimed).

`stock_auto_paused` becomes `true` only in `confirmAutomaticEndOwnership`, one
atomic statement that requires:

- the same AUTOMATIC intent, desired INACTIVE, not yet auto-paused;
- the listing in the session account, environment and `allegro-hu`;
- a persisted ENDED/INACTIVE observation no older than 15 minutes (the same
  window as the publication operation's cached match);
- a journal END command created for exactly this intent (`ATTEMPTED` with this
  `intentId`, after the intent was recorded) and a `SUCCESS` of the same command
  for this listing, offer and account whose `commandEvidence` is
  `ALLEGRO_TASK_SUCCESS`, i.e. Allegro's own task report says this command
  succeeded for this offer.

A matching remote state proves the publication goal, not that our command
caused it (manual END in Allegro, sell-out, another system). The publication
operation therefore journals `SUCCESS` with `commandEvidence =
REMOTE_STATE_ONLY` when the task report does not confirm the command; a lagging
task report is re-checked read-only within the bounded window first. Such a
`SUCCESS` closes the command (no resend) but never confers ownership: the
listing stays `PENDING_AUTOMATIC` and is reported `OWNERSHIP_UNRESOLVED` until
an operator decides. HTTP 202/PENDING, `ALREADY_FIXED` without a command, an
ENDED observation alone, a stale observation or evidence of another intent
never confirm ownership. A pending automatic intent is read back on later runs
and confirmed only from that evidence.

Publication journal: every command audit carries the command's own `intentId`.
Unresolved commands are never resent and never replaced by a new command id.
Task lookups distinguish `TASK_NOT_FOUND`, `TASK_PENDING`, `RATE_LIMITED`,
`AUTH_FAILED`, `UPSTREAM_ERROR`, `TIMEOUT`, `REQUEST_FAILED` and
`DISPATCH_AMBIGUOUS`; after bounded verification the result and the PENDING
audit carry a diagnostic (command id, intent id, command age, upstream status,
sanitized Allegro errors, operator hint). Automatic replay is excluded: Allegro
documents PUT idempotency only as a general guideline, not as the contract of
`offer-publication-commands`.

### Deployment order

1. Pause automation (scheduler switches off) and wait until no inventory slice
   holds its lease.
2. Apply `0029_publication_intent.sql` manually to Neon in ONE transaction with
   a lock timeout. The file has no statement breakpoints and is not
   idempotent; one transaction makes it all-or-nothing:

   ```sql
   BEGIN;
   SET LOCAL lock_timeout = '5s';
   SET LOCAL statement_timeout = '60s';
   -- contents of packages/database/drizzle/0029_publication_intent.sql
   COMMIT;
   ```

   Locks: `ADD COLUMN` (nullable, no default) is metadata-only; each
   `ADD CONSTRAINT ... CHECK` validates the table under ACCESS EXCLUSIVE (all
   values NULL, one fast scan); `CREATE TRIGGER` takes SHARE ROW EXCLUSIVE.
   Expected duration: well under a second. If the lock timeout fires, nothing
   is applied; retry later.
3. Verify read-only: the three columns, both constraints and the trigger exist,
   and every row has a NULL intent.
4. Deploy the API. The new code selects the new columns, so it must not run
   before the migration. The previous code keeps working with the migration
   applied.
5. Re-enable automation and watch `OWNERSHIP_UNRESOLVED`, `PENDING`,
   `PUBLICATION_COMMAND_UNRESOLVED` and the diagnostic `taskState` values.

### Rollback runbook (keeps all intent data)

Schema compatibility is not behavioral safety. With the migration in place the
previous application version runs, but:

- it does not know `PENDING_AUTOMATIC`: a desired INACTIVE row that is not
  auto-paused looks manual to it, so it neither retries an automatic END that
  has not taken effect (an ACTIVE offer at zero target stays ACTIVE) nor
  reactivates the offer when stock returns;
- its publication writers set no intent, so the guard trigger clears the intent
  of every row they write (fail closed: after a re-deploy those rows are
  `UNRESOLVED` or `LEGACY_AUTO_PAUSED`, never automatic);
- its 202 path sets `stock_auto_paused` without evidence (its old behavior).

Steps:

1. Pause automation.
2. Record the intents before any old-version write can clear them (read-only
   export; an additive copy table only with explicit approval):

   ```sql
   SELECT d.listing_id, pl.external_listing_id, d.desired_publication_status,
          d.stock_auto_paused, d.publication_intent_source, d.publication_intent_id,
          d.publication_intent_at, r.publication_status, r.updated_at
   FROM listing_desired_states d
   JOIN platform_listings pl ON pl.id = d.listing_id
   LEFT JOIN listing_remote_states r ON r.listing_id = d.listing_id
   WHERE d.publication_intent_id IS NOT NULL
   ORDER BY d.publication_intent_at;
   ```

3. Resolve pending automatic ENDs that the old version would treat as manual
   (`publication_intent_source = 'AUTOMATIC'`, `desired_publication_status =
   'INACTIVE'`, `stock_auto_paused = false`): for each offer still ACTIVE,
   check its latest `PUBLICATION_OPERATION` journal entry and the offer in
   Allegro, then decide manually (END or ACTIVE). Never resend a command id.
4. Redeploy the previous API build. Do not drop the columns, constraints or
   trigger, and do not update or delete intent rows.
5. Re-enable automation only after step 3.
6. A later re-deploy of the new version needs no data step: rows touched by the
   old version are `UNRESOLVED`/`LEGACY_AUTO_PAUSED`, and old `SUCCESS` entries
   carry no `commandEvidence`, so they never confer ownership.

Removing the schema is not part of a rollback: it would destroy the recorded
intents.

### PostgreSQL behavioral tests (PGlite)

`apps/api/test/support/postgres.ts` creates an in-process PostgreSQL
(`@electric-sql/pglite`, development dependency only, never imported by
runtime code) and applies every repository migration in journal order.
`test/*.pg.test.ts` run real SQL: constraints, the trigger, CAS statements and
the publication journal. Limitations: one connection, so concurrency is tested
as serialized interleavings rather than parallel sessions (row-lock waits and
READ COMMITTED re-evaluation of concurrent UPDATEs are not exercised); PGlite's
PostgreSQL major version can differ from Neon's; queries go through drizzle's
PGlite driver instead of the Neon HTTP driver.
