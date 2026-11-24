-- Migration 0029 (publication intent): PRODUCTION PREFLIGHT - READ ONLY
--
-- Run BEFORE applying packages/database/drizzle/0029_publication_intent.sql.
-- Every statement runs inside a READ ONLY transaction that is rolled back:
-- any accidental write fails with "cannot execute ... in a read-only
-- transaction". No psql meta-commands, so it also runs in the Neon SQL editor.
--
-- Go criteria are in docs/runbooks/0029-publication-intent-checklist.md.
-- Every row has a "check" label; rows with an "ok" column must be true.

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL statement_timeout = '30s';

-- P1  Server version: gen_random_uuid() is core from PostgreSQL 13.
SELECT 'P1_server_version' AS check,
       current_setting('server_version') AS value,
       current_setting('server_version_num')::int >= 130000 AS ok;

-- P2  Target and read-only guarantee (read_only must be "on").
SELECT 'P2_target' AS check,
       current_database() AS database,
       current_user AS role,
       current_schema() AS schema,
       current_setting('transaction_read_only') AS read_only,
       current_setting('transaction_read_only') = 'on' AS ok;

-- P3  0029 not applied yet: none of the intent columns exist.
SELECT 'P3_intent_columns_absent' AS check,
       count(*) AS present,
       count(*) = 0 AS ok
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'listing_desired_states'
  AND column_name IN ('publication_intent_source', 'publication_intent_id', 'publication_intent_at');

-- P4  No object with a 0029 name exists (a half-applied migration).
SELECT 'P4_0029_objects_absent' AS check,
       (SELECT count(*) FROM pg_constraint
         WHERE conname IN ('listing_desired_states_publication_intent_source_check',
                           'listing_desired_states_publication_intent_consistency_check')) AS constraints,
       (SELECT count(*) FROM pg_proc
         WHERE proname = 'listing_desired_states_publication_intent_guard') AS functions,
       (SELECT count(*) FROM pg_trigger
         WHERE tgname = 'listing_desired_states_publication_intent_guard') AS triggers,
       (SELECT count(*) FROM pg_constraint
         WHERE conname IN ('listing_desired_states_publication_intent_source_check',
                           'listing_desired_states_publication_intent_consistency_check'))
       + (SELECT count(*) FROM pg_proc WHERE proname = 'listing_desired_states_publication_intent_guard')
       + (SELECT count(*) FROM pg_trigger WHERE tgname = 'listing_desired_states_publication_intent_guard') = 0 AS ok;

-- P5  Columns the migration and the new code rely on (expect 7 rows).
SELECT 'P5_required_columns' AS check, column_name, data_type, udt_name, is_nullable
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'listing_desired_states'
  AND column_name IN ('listing_id', 'desired_publication_status', 'stock_auto_paused',
                      'stock_locked', 'auto_stock_sync', 'updated_by', 'updated_at')
ORDER BY column_name;

-- P6  Existing user triggers on the table (expected: none).
SELECT 'P6_existing_triggers' AS check, tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'listing_desired_states'::regclass AND NOT tgisinternal;

-- P7  Size estimate for the ACCESS EXCLUSIVE CHECK validation scan.
SELECT 'P7_table_size' AS check,
       count(*) AS row_count,
       pg_size_pretty(pg_total_relation_size('listing_desired_states'::regclass)) AS total_size
FROM listing_desired_states;

-- P8  Other open transactions (any long-running one would block the DDL).
SELECT 'P8_open_transactions' AS check,
       pid, state, xact_start, now() - xact_start AS age, application_name,
       left(regexp_replace(coalesce(query, ''), '\s+', ' ', 'g'), 80) AS query_head
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
  AND xact_start IS NOT NULL
ORDER BY xact_start;

-- P9  Locks currently held or awaited on the table (expected: none).
SELECT 'P9_table_locks' AS check, l.pid, l.mode, l.granted
FROM pg_locks l
WHERE l.relation = 'listing_desired_states'::regclass
  AND l.pid <> pg_backend_pid();

-- P10 Live scheduler / publication leases (expected: none = automation idle).
SELECT 'P10_live_leases' AS check, name, locked_until, now() AS checked_at
FROM scheduler_leases
WHERE locked_until > now()
ORDER BY name;

-- P11 Unresolved publication commands (latest command not terminal).
--     The new code keeps verifying these read-only and never resends them;
--     review each one before deploying.
WITH latest AS (
  SELECT DISTINCT ON (e.listing_id)
         e.listing_id, e.old_value AS action, e.new_value AS status,
         e.metadata_json::jsonb ->> 'commandId' AS command_id,
         e.metadata_json::jsonb ->> 'offerId' AS offer_id,
         e.occurred_at
  FROM allegro_change_events e
  WHERE e.event_type = 'PUBLICATION_OPERATION'
  ORDER BY e.listing_id, e.occurred_at DESC, e.id DESC
)
SELECT 'P11_unresolved_commands' AS check, listing_id, offer_id, action, status, command_id,
       occurred_at, now() - occurred_at AS age
FROM latest
WHERE status NOT IN ('SUCCESS', 'FAILED', 'CANCELLED_BEFORE_SEND')
ORDER BY occurred_at;

-- P12 Legacy inventory publication markers (block new commands as before).
WITH latest_sync AS (
  SELECT DISTINCT ON (e.listing_id) e.listing_id, e.old_value, e.new_value, e.occurred_at
  FROM allegro_change_events e
  WHERE e.event_type = 'SYNC' AND e.source = 'INVENTORY_AUTOMATION'
  ORDER BY e.listing_id, e.occurred_at DESC, e.id DESC
)
SELECT 'P12_legacy_pending_markers' AS check, count(*) AS listings
FROM latest_sync
WHERE (old_value IN ('END', 'ACTIVATE', 'STOCK_UPDATE_AND_ACTIVATE') AND new_value = 'PENDING')
   OR new_value = 'REACTIVATION_IN_PROGRESS';

-- P13 Baseline publication state (compare after deploy). After 0029 every
--     row starts without intent: auto-paused rows become LEGACY_AUTO_PAUSED,
--     desired INACTIVE rows without auto-pause become UNRESOLVED (manual).
SELECT 'P13_baseline' AS check,
       d.desired_publication_status::text AS desired,
       d.stock_auto_paused,
       d.stock_locked,
       d.auto_stock_sync,
       r.publication_status::text AS remote,
       count(*) AS listings
FROM listing_desired_states d
LEFT JOIN listing_remote_states r ON r.listing_id = d.listing_id
GROUP BY 2, 3, 4, 5, 6
ORDER BY 2, 3, 4, 5, 6;

-- P14 Auto-paused listings that are ACTIVE remotely (pre-existing anomalies).
SELECT 'P14_auto_paused_but_active' AS check, d.listing_id, pl.external_listing_id,
       r.publication_status::text AS remote, r.updated_at AS observed_at
FROM listing_desired_states d
JOIN platform_listings pl ON pl.id = d.listing_id
LEFT JOIN listing_remote_states r ON r.listing_id = d.listing_id
WHERE d.stock_auto_paused AND r.publication_status::text IN ('ACTIVE', 'ACTIVATING')
ORDER BY r.updated_at;

-- P15 Migration bookkeeping (informational: is drizzle's table in use?).
SELECT 'P15_drizzle_migrations_table' AS check,
       to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present;

ROLLBACK;
