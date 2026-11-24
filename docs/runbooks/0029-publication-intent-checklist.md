# Migration 0029 – publication intent: migration, deploy and rollback checklist

Scope: PR `fix/allegro-publication-recovery-20261124` (commit `03067ee`), which
adds durable publication intent and evidence-based auto-pause ownership.
Background: [ALLEGRO_PUBLICATION_OPERATIONS.md](../ALLEGRO_PUBLICATION_OPERATIONS.md).

Each step has an owner tick box. **Stop** means: do not continue, keep or
restore the previous state, and investigate. Nothing in this checklist
sends an Allegro write.

Reviewed migration text:
`git show 03067ee:packages/database/drizzle/0029_publication_intent.sql | sha256sum`
= `3c335ad3a8dcb1da6c2cc6ea3d0d7646a6c350fa1c17ec21cb2fff5ea96cac51`
(hash the git object, not a working-tree copy, so line-ending conversion
cannot change it).

## 0. Preconditions (before the maintenance window)

- [ ] The PR is merged to `main`, or the exact commit to deploy is known; its
      0029 file hash matches the value above.
- [ ] The current production API build/deployment id is written down
      (this is the rollback target).
- [ ] A Neon restore point exists: note the current time / LSN for
      point-in-time restore, or create a Neon branch of production as a
      snapshot. This is the last-resort recovery path only; the planned
      rollback never restores data.
- [ ] Operator access to Allegro Seller Panel is available for step R3.
- [ ] Optional but recommended: the real concurrency tests (see the PR)
      have passed against a non-production PostgreSQL.

## 1. Pause automation

- [ ] In Deno Deploy: `COMMERCE_HUB_DENO_CRON_ENABLED=false` (and keep
      `COMMERCE_HUB_SCHEDULERS_ENABLED` not `true`). Note the previous values.
- [ ] Wait until the running inventory slice, if any, has finished: preflight
      **P10** shows no live `inventory-refresh:*` or `allegro-publication:*`
      lease.
- [ ] Nobody uses the Commerce Hub publication actions during the window.

## 2. Read-only preflight

Run [0029-preflight.sql](0029-preflight.sql) (READ ONLY transaction, rolled
back). Save the output with the date.

| Check | Go condition |
|---|---|
| P1 | `ok = true` (PostgreSQL ≥ 13) |
| P2 | `read_only = on`, database/role are the intended production ones |
| P3, P4 | `ok = true` (0029 not applied, no half-applied objects) |
| P5 | 7 rows; `stock_auto_paused`, `stock_locked`, `auto_stock_sync` boolean, `listing_id` uuid |
| P6 | no rows (no unexpected trigger on the table) |
| P7 | row count noted (expected small; the CHECK scan is proportional) |
| P8 | no transaction older than a few seconds (else wait or investigate) |
| P9 | no rows |
| P10 | no rows |
| P11 | every listed command is understood; none is younger than 15 minutes |
| P12 | noted (legacy markers keep blocking as before) |
| P13, P14 | saved as the baseline |

**Stop** if any go condition fails.

## 3. Apply the migration (one transaction)

With psql (≥ 10), from the repository at the reviewed commit:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -c "SET lock_timeout = '5s'" -c "SET statement_timeout = '60s'" \
  -f packages/database/drizzle/0029_publication_intent.sql
```

Or in the Neon SQL editor, as one execution:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- paste the full, unmodified content of 0029_publication_intent.sql here
COMMIT;
```

- [ ] The run ends with `COMMIT` and no error.
- [ ] On any error (for example a lock timeout) the transaction is rolled back
      as a whole: re-run the preflight (P3/P4 must again be `ok`) and retry
      later. Never run parts of the file separately.
- [ ] Do NOT record it in `drizzle.__drizzle_migrations` and do not run
      `drizzle-kit migrate`/`push` (P15 shows whether that table exists; the
      repository applies migrations manually).

Expected duration: well under one second (metadata-only column add, one
validation scan per CHECK, trigger creation).

## 4. Read-only postflight (schema)

Run section A of [0029-postflight.sql](0029-postflight.sql).

- [ ] A1: three rows, all `ok = true`.
- [ ] A2: two rows, all `ok = true` (validated).
- [ ] A3: one row, `ok = true` (enabled, BEFORE UPDATE, row level, columns
      `desired_publication_status, stock_auto_paused`).
- [ ] A4: `ok = true` (no backfill).

**Stop** if any check fails: do not deploy the API. The previous API keeps
working with the migration in place; investigate before going further.

## 5. Deploy the API

- [ ] Deploy the reviewed commit to Deno Deploy (automation still paused).
- [ ] Read-only smoke test: the listings page loads; `GET` endpoints that read
      `listing_desired_states` return 200; no `column ... does not exist` errors
      in the logs.
- [ ] Postflight B1 shows only `NONE`, `LEGACY_AUTO_PAUSED`, `UNRESOLVED`
      (and `MANUAL` if someone already used the UI).

## 6. Re-enable automation and observe

- [ ] Restore the scheduler switches noted in step 1.
- [ ] After the first scheduled inventory run, run postflight section B:
  - B2: pending automatic ENDs are expected only right after a zero-stock END;
    an entry older than one run with `command_evidence = REMOTE_STATE_ONLY`
    or `task_state = TASK_NOT_FOUND` needs an operator decision.
  - B3: `REMOTE_STATE_ONLY` should be rare compared with
    `ALLEGRO_TASK_SUCCESS`.
  - B4: unresolved commands by task state; anything older than a few hours
    needs review.
  - B5: `AUTOMATIC_END_CONFIRMED` appears for confirmed automatic ENDs.
- [ ] In the inventory run results, review `OWNERSHIP_UNRESOLVED`,
      `PUBLICATION_COMMAND_UNRESOLVED` and `PENDING` counts against the
      baseline.

Rollback triggers: an unexpected END/ACTIVATE, an increase of offers that
stay ACTIVE at zero target stock, or errors writing `listing_desired_states`.

## R. Rollback (application only; all intent data kept)

The migration stays in place. Schema compatibility does not make the previous
version behave identically (see "Rollback runbook" in
ALLEGRO_PUBLICATION_OPERATIONS.md): it treats a pending automatic END as a
manual decision and does not retry it.

- [ ] R1. Pause automation (step 1).
- [ ] R2. Export the intents (read-only) and save the output:

  ```sql
  BEGIN TRANSACTION READ ONLY;
  SELECT d.listing_id, pl.external_listing_id, d.desired_publication_status::text,
         d.stock_auto_paused, d.publication_intent_source, d.publication_intent_id,
         d.publication_intent_at, r.publication_status::text AS remote, r.updated_at
  FROM listing_desired_states d
  JOIN platform_listings pl ON pl.id = d.listing_id
  LEFT JOIN listing_remote_states r ON r.listing_id = d.listing_id
  WHERE d.publication_intent_id IS NOT NULL
  ORDER BY d.publication_intent_at;
  ROLLBACK;
  ```

- [ ] R3. For each pending automatic END (postflight B2) whose offer is still
      ACTIVE: check the latest journal command and the offer in Allegro, then
      decide manually (END or ACTIVE) in the UI. Never resend a command id.
- [ ] R4. Redeploy the API build noted in step 0.
- [ ] R5. Do not drop the columns, constraints or trigger; do not update or
      delete intent rows.
- [ ] R6. Re-enable automation only after R3 is complete.
- [ ] R7. Later re-deploy of the new version: no data step needed (rows the old
      version wrote are `UNRESOLVED`/`LEGACY_AUTO_PAUSED`; its `SUCCESS` entries
      have no `commandEvidence` and never confer ownership). Run the
      postflight A and B sections again.

Last resort only (data loss, separate approval): Neon point-in-time restore
to the point noted in step 0.
