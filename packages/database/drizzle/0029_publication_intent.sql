-- Durable publication intent for listing_desired_states.
--
-- Additive only. Existing rows keep NULL intent (legacy / unresolved): the
-- migration never grants automatic ownership and performs no backfill.
--
-- Intent-aware writers always set a new publication_intent_id (or, for an
-- intent-preserving automatic transition, a new publication_intent_at).
-- The trigger makes every other writer fail closed: if a statement WRITES
-- desired_publication_status or stock_auto_paused (lists it in SET, even
-- with an unchanged value) without touching the intent columns, the intent
-- is cleared to NULL (unresolved). An unknown or legacy writer - including
-- the previous application version after a rollback - can therefore never
-- leave behind a stale automatic intent, not even with a same-value manual
-- decision. Stock-, price-, lock- and flag-only updates do not list these
-- columns and keep the intent.

ALTER TABLE listing_desired_states
  ADD COLUMN publication_intent_source text,
  ADD COLUMN publication_intent_id uuid,
  ADD COLUMN publication_intent_at timestamp with time zone;

ALTER TABLE listing_desired_states
  ADD CONSTRAINT listing_desired_states_publication_intent_source_check
  CHECK (
    publication_intent_source IS NULL
    OR publication_intent_source IN ('AUTOMATIC', 'MANUAL')
  );

ALTER TABLE listing_desired_states
  ADD CONSTRAINT listing_desired_states_publication_intent_consistency_check
  CHECK (
    (
      publication_intent_source IS NULL
      AND publication_intent_id IS NULL
      AND publication_intent_at IS NULL
    )
    OR (
      publication_intent_source IS NOT NULL
      AND publication_intent_id IS NOT NULL
      AND publication_intent_at IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION listing_desired_states_publication_intent_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Fires only for UPDATEs that list desired_publication_status or
  -- stock_auto_paused (see the trigger's column list).
  IF NEW.publication_intent_id IS NOT DISTINCT FROM OLD.publication_intent_id
  AND NEW.publication_intent_at IS NOT DISTINCT FROM OLD.publication_intent_at
  THEN
    NEW.publication_intent_source := NULL;
    NEW.publication_intent_id := NULL;
    NEW.publication_intent_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER listing_desired_states_publication_intent_guard
BEFORE UPDATE OF desired_publication_status, stock_auto_paused ON listing_desired_states
FOR EACH ROW
EXECUTE FUNCTION listing_desired_states_publication_intent_guard();
