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
