-- Migration 0029 (publication intent): POSTFLIGHT - READ ONLY
--
-- Run right AFTER applying 0029 and BEFORE deploying the API (section A),
-- and again after the API deploy for monitoring (section B).
-- READ ONLY transaction, rolled back; no psql meta-commands.

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL statement_timeout = '30s';

-- ===================== A. Schema verification =====================

-- A1  Three nullable intent columns with the expected types.
SELECT 'A1_intent_columns' AS check, column_name, data_type, is_nullable,
       (column_name, data_type, is_nullable) IN (
         ('publication_intent_source', 'text', 'YES'),
         ('publication_intent_id', 'uuid', 'YES'),
         ('publication_intent_at', 'timestamp with time zone', 'YES')) AS ok
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'listing_desired_states'
  AND column_name LIKE 'publication_intent_%'
ORDER BY column_name;

-- A2  Both CHECK constraints exist and are validated.
SELECT 'A2_constraints' AS check, conname, contype, convalidated AS ok
FROM pg_constraint
WHERE conrelid = 'listing_desired_states'::regclass
  AND conname IN ('listing_desired_states_publication_intent_source_check',
                  'listing_desired_states_publication_intent_consistency_check')
ORDER BY conname;

-- A3  Guard trigger: enabled, BEFORE UPDATE, row level, on exactly the two
--     columns desired_publication_status and stock_auto_paused.
SELECT 'A3_trigger' AS check,
       t.tgname,
       t.tgenabled = 'O' AS enabled,
       (t.tgtype & 1) = 1 AS row_level,
       (t.tgtype & 2) = 2 AS before,
       (t.tgtype & 16) = 16 AS on_update,
       p.proname AS function_name,
       (SELECT array_agg(a.attname::text ORDER BY a.attname)
          FROM unnest(t.tgattr) AS k(attnum)
          JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum) AS columns,
       t.tgenabled = 'O' AND (t.tgtype & 19) = 19
         AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                FROM unnest(t.tgattr) AS k(attnum)
                JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum)
             = ARRAY['desired_publication_status', 'stock_auto_paused'] AS ok
FROM pg_trigger t
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'listing_desired_states'::regclass
  AND t.tgname = 'listing_desired_states_publication_intent_guard';

-- A4  No backfill: immediately after the migration every intent is NULL.
SELECT 'A4_no_intents_yet' AS check,
       count(*) FILTER (WHERE publication_intent_id IS NOT NULL) AS with_intent,
       count(*) AS total,
       count(*) FILTER (WHERE publication_intent_id IS NOT NULL) = 0 AS ok
FROM listing_desired_states;

-- ===================== B. Post-deploy monitoring ==================

-- B1  Ownership classes (as the API classifies them).
SELECT 'B1_ownership_classes' AS check,
       CASE
         WHEN d.stock_auto_paused AND d.publication_intent_id IS NOT NULL AND d.publication_intent_source = 'AUTOMATIC' THEN 'CONFIRMED_AUTOMATIC'
         WHEN d.stock_auto_paused AND d.publication_intent_id IS NULL THEN 'LEGACY_AUTO_PAUSED'
         WHEN d.stock_auto_paused THEN 'UNRESOLVED'
         WHEN d.desired_publication_status::text <> 'INACTIVE' THEN 'NONE'
         WHEN d.publication_intent_source = 'AUTOMATIC' THEN 'PENDING_AUTOMATIC'
         WHEN d.publication_intent_source = 'MANUAL' THEN 'MANUAL'
         ELSE 'UNRESOLVED'
       END AS ownership,
       count(*) AS listings
FROM listing_desired_states d
GROUP BY 2
ORDER BY 2;

-- B2  Pending automatic END intents with their latest command and age.
WITH latest AS (
  SELECT DISTINCT ON (e.listing_id)
         e.listing_id, e.old_value AS action, e.new_value AS status,
         e.metadata_json::jsonb ->> 'commandId' AS command_id,
         e.metadata_json::jsonb ->> 'intentId' AS command_intent_id,
         e.metadata_json::jsonb ->> 'commandEvidence' AS command_evidence,
         e.metadata_json::jsonb -> 'diagnostic' ->> 'taskState' AS task_state,
         e.occurred_at
  FROM allegro_change_events e
  WHERE e.event_type = 'PUBLICATION_OPERATION'
  ORDER BY e.listing_id, e.occurred_at DESC, e.id DESC
)
SELECT 'B2_pending_automatic' AS check,
       d.listing_id, pl.external_listing_id, d.publication_intent_id, d.publication_intent_at,
       r.publication_status::text AS remote, r.updated_at AS observed_at,
       l.action, l.status, l.command_id, l.command_intent_id = d.publication_intent_id::text AS command_of_this_intent,
       l.command_evidence, l.task_state, now() - l.occurred_at AS command_age
FROM listing_desired_states d
JOIN platform_listings pl ON pl.id = d.listing_id
LEFT JOIN listing_remote_states r ON r.listing_id = d.listing_id
LEFT JOIN latest l ON l.listing_id = d.listing_id
WHERE NOT d.stock_auto_paused
  AND d.desired_publication_status::text = 'INACTIVE'
  AND d.publication_intent_source = 'AUTOMATIC'
ORDER BY d.publication_intent_at;

-- B3  Command evidence mix since the deploy (REMOTE_STATE_ONLY should be rare).
SELECT 'B3_success_evidence' AS check,
       e.old_value AS action,
       coalesce(e.metadata_json::jsonb ->> 'commandEvidence', 'NONE (legacy/no command)') AS evidence,
       count(*) AS events
FROM allegro_change_events e
WHERE e.event_type = 'PUBLICATION_OPERATION' AND e.new_value = 'SUCCESS'
  AND e.occurred_at > now() - interval '7 days'
GROUP BY 2, 3
ORDER BY 2, 3;

-- B4  Unresolved commands by diagnostic task state and age.
WITH latest AS (
  SELECT DISTINCT ON (e.listing_id) e.listing_id, e.new_value AS status, e.metadata_json, e.occurred_at
  FROM allegro_change_events e
  WHERE e.event_type = 'PUBLICATION_OPERATION'
  ORDER BY e.listing_id, e.occurred_at DESC, e.id DESC
)
SELECT 'B4_unresolved_commands' AS check,
       coalesce(metadata_json::jsonb -> 'diagnostic' ->> 'taskState', status) AS state,
       count(*) AS listings,
       max(now() - occurred_at) AS oldest
FROM latest
WHERE status NOT IN ('SUCCESS', 'FAILED', 'CANCELLED_BEFORE_SEND')
GROUP BY 2
ORDER BY 2;

-- B5  Ownership confirmations recorded by the new code.
SELECT 'B5_ownership_confirmations' AS check,
       metadata_json::jsonb ->> 'reason' AS reason, count(*) AS events, max(occurred_at) AS latest
FROM allegro_change_events
WHERE event_type = 'OWNERSHIP' AND occurred_at > now() - interval '7 days'
GROUP BY 2;

ROLLBACK;
