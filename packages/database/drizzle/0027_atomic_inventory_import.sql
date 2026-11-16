CREATE OR REPLACE FUNCTION apply_inventory_snapshot(
  p_connection_id uuid,
  p_import_run_id uuid,
  p_items jsonb,
  p_rows_read integer,
  p_rows_normalized_to_zero integer,
  p_duplicate_sku_count integer,
  p_source_fingerprint text,
  p_lease_name text,
  p_lease_owner_id uuid
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
  v_changed_count integer;
  v_now timestamptz := now();
BEGIN
  IF p_lease_name IS DISTINCT FROM
     ('inventory-refresh:' || p_connection_id::text) THEN
    RAISE EXCEPTION 'Invalid inventory lease name';
  END IF;

  -- Fence stale workers at the database write boundary.
  -- Lock the lease row so ownership cannot change during this transaction.
  PERFORM 1
  FROM scheduler_leases
  WHERE name = p_lease_name
    AND owner_id = p_lease_owner_id
    AND locked_until > clock_timestamp()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory import lease is missing, expired, or not owned';
  END IF;

  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Inventory snapshot must be a JSON array';
  END IF;

  IF jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'Inventory snapshot cannot be empty';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended(p_connection_id::text, 0)
  ) THEN
    RAISE EXCEPTION 'Another inventory import is active for this connection';
  END IF;

  -- Never finalize another import implicitly.
  -- Recovery must be verified separately under the execution lease.
  IF EXISTS (
    SELECT 1
    FROM inventory_import_runs
    WHERE connection_id = p_connection_id
      AND id <> p_import_run_id
      AND status = 'RUNNING'
  ) THEN
    RAISE EXCEPTION 'Another inventory import run is still active';
  END IF;

  SELECT status
  INTO v_status
  FROM inventory_import_runs
  WHERE id = p_import_run_id
    AND connection_id = p_connection_id
  FOR UPDATE;

  IF v_status IS DISTINCT FROM 'RUNNING' THEN
    RAISE EXCEPTION 'Inventory import run is not active';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM inventory_import_runs newer
    JOIN inventory_import_runs current_run
      ON current_run.id = p_import_run_id
    WHERE newer.connection_id = p_connection_id
      AND newer.id <> p_import_run_id
      AND newer.status IN ('SUCCESS', 'NO_CHANGE')
      AND newer.started_at >= current_run.started_at
  ) THEN
    RAISE EXCEPTION 'A newer inventory import has already completed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items)
      AS item(sku text, stock integer)
    WHERE item.sku IS NULL
       OR btrim(item.sku) = ''
       OR item.stock IS NULL
  ) THEN
    RAISE EXCEPTION 'Inventory snapshot contains invalid items';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_items)
      AS item(sku text)
    GROUP BY item.sku
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Inventory snapshot contains duplicate SKUs';
  END IF;

  SELECT count(*)::integer
  INTO v_changed_count
  FROM (
    SELECT
      incoming.sku,
      incoming.stock
    FROM jsonb_to_recordset(p_items)
      AS incoming(sku text, stock integer)

    FULL OUTER JOIN (
      SELECT sku, stock
      FROM inventory_source_items
      WHERE connection_id = p_connection_id
    ) existing
      ON existing.sku = incoming.sku

    WHERE existing.sku IS NULL
       OR incoming.sku IS NULL
       OR existing.stock IS DISTINCT FROM incoming.stock
  ) changes;

  INSERT INTO inventory_source_items (
    connection_id,
    sku,
    stock,
    source_stock_value,
    normalized_to_zero,
    last_import_run_id,
    observed_at,
    updated_at
  )
  SELECT
    p_connection_id,
    item.sku,
    item.stock,
    item.source_stock_value,
    COALESCE(item.normalized_to_zero, false),
    p_import_run_id,
    v_now,
    v_now
  FROM jsonb_to_recordset(p_items)
    AS item(
      sku text,
      stock integer,
      source_stock_value text,
      normalized_to_zero boolean
    )
  ON CONFLICT (connection_id, sku)
  DO UPDATE SET
    stock = EXCLUDED.stock,
    source_stock_value = EXCLUDED.source_stock_value,
    normalized_to_zero = EXCLUDED.normalized_to_zero,
    last_import_run_id = EXCLUDED.last_import_run_id,
    observed_at = EXCLUDED.observed_at,
    updated_at = EXCLUDED.updated_at;

  DELETE FROM inventory_source_items
  WHERE connection_id = p_connection_id
    AND last_import_run_id IS DISTINCT FROM p_import_run_id;

  UPDATE inventory_import_runs
  SET
    status = 'SUCCESS',
    rows_read = p_rows_read,
    rows_imported = jsonb_array_length(p_items),
    rows_normalized_to_zero = p_rows_normalized_to_zero,
    duplicate_sku_count = p_duplicate_sku_count,
    changed_item_count = v_changed_count,
    source_fingerprint = p_source_fingerprint,
    finished_at = v_now,
    error = NULL
  WHERE id = p_import_run_id
    AND connection_id = p_connection_id;

  UPDATE data_connections
  SET
    status = CASE
      WHEN p_duplicate_sku_count > 0
        THEN 'READY_WITH_WARNINGS'
      ELSE 'READY'
    END,
    last_successful_at = v_now,
    last_error = NULL,
    updated_at = v_now
  WHERE id = p_connection_id;

  RETURN v_changed_count;
END;
$$;

-- Atomically finalize an unchanged inventory import under the same lease.
CREATE OR REPLACE FUNCTION finalize_unchanged_inventory_import(
  p_connection_id uuid,
  p_import_run_id uuid,
  p_rows_read integer,
  p_rows_imported integer,
  p_rows_normalized_to_zero integer,
  p_duplicate_sku_count integer,
  p_source_fingerprint text,
  p_lease_name text,
  p_lease_owner_id uuid
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := now();
  v_previous_status text;
  v_previous_fingerprint text;
BEGIN
  IF p_lease_name IS DISTINCT FROM
     ('inventory-refresh:' || p_connection_id::text) THEN
    RAISE EXCEPTION 'Invalid inventory lease name';
  END IF;

  PERFORM 1
  FROM scheduler_leases
  WHERE name = p_lease_name
    AND owner_id = p_lease_owner_id
    AND locked_until > clock_timestamp()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory import lease is missing, expired, or not owned';
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended(p_connection_id::text, 0)
  ) THEN
    RAISE EXCEPTION 'Another inventory import is active for this connection';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM inventory_import_runs
    WHERE id = p_import_run_id
      AND connection_id = p_connection_id
      AND status = 'RUNNING'
    FOR UPDATE
  ) THEN
    RAISE EXCEPTION 'Inventory import run is not active';
  END IF;

  -- Never finalize another import implicitly.
  -- Recovery must be verified separately under the execution lease.
  IF EXISTS (
    SELECT 1
    FROM inventory_import_runs
    WHERE connection_id = p_connection_id
      AND id <> p_import_run_id
      AND status = 'RUNNING'
  ) THEN
    RAISE EXCEPTION 'Another inventory import run is still active';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM inventory_import_runs newer
    JOIN inventory_import_runs current_run
      ON current_run.id = p_import_run_id
    WHERE newer.connection_id = p_connection_id
      AND newer.id <> p_import_run_id
      AND newer.status IN ('SUCCESS', 'NO_CHANGE')
      AND newer.started_at >= current_run.started_at
  ) THEN
    RAISE EXCEPTION 'A newer inventory import has already completed';
  END IF;
  SELECT status, source_fingerprint
  INTO v_previous_status, v_previous_fingerprint
  FROM inventory_import_runs
  WHERE connection_id = p_connection_id
    AND id <> p_import_run_id
  ORDER BY started_at DESC, created_at DESC, id DESC
  LIMIT 1;

  IF v_previous_status NOT IN ('SUCCESS', 'NO_CHANGE')
     OR v_previous_fingerprint IS DISTINCT FROM p_source_fingerprint THEN
    RAISE EXCEPTION 'Inventory fingerprint is no longer eligible for NO_CHANGE';
  END IF;

  UPDATE inventory_import_runs
  SET
    status = 'NO_CHANGE',
    rows_read = p_rows_read,
    rows_imported = p_rows_imported,
    rows_normalized_to_zero = p_rows_normalized_to_zero,
    duplicate_sku_count = p_duplicate_sku_count,
    changed_item_count = 0,
    source_fingerprint = p_source_fingerprint,
    finished_at = v_now,
    error = NULL
  WHERE id = p_import_run_id
    AND connection_id = p_connection_id;

  UPDATE data_connections
  SET
    status = CASE
      WHEN p_duplicate_sku_count > 0
        THEN 'READY_WITH_WARNINGS'
      ELSE 'READY'
    END,
    last_successful_at = v_now,
    last_error = NULL,
    updated_at = v_now
  WHERE id = p_connection_id;
END;
$$;
-- Atomically finalize a failed inventory import.
CREATE OR REPLACE FUNCTION fail_inventory_import(
  p_connection_id uuid,
  p_import_run_id uuid,
  p_error text,
  p_lease_name text,
  p_lease_owner_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_started_at timestamptz;
BEGIN
  IF p_lease_name IS DISTINCT FROM
     ('inventory-refresh:' || p_connection_id::text) THEN
    RAISE EXCEPTION 'Invalid inventory lease name';
  END IF;

  PERFORM 1
  FROM scheduler_leases
  WHERE name = p_lease_name
    AND owner_id = p_lease_owner_id
    AND locked_until > clock_timestamp()
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF NOT pg_try_advisory_xact_lock(
    hashtextextended(p_connection_id::text, 0)
  ) THEN
    RETURN false;
  END IF;

  SELECT started_at
  INTO v_started_at
  FROM inventory_import_runs
  WHERE id = p_import_run_id
    AND connection_id = p_connection_id
    AND status = 'RUNNING'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM inventory_import_runs
    WHERE connection_id = p_connection_id
      AND id <> p_import_run_id
      AND status IN ('SUCCESS', 'NO_CHANGE')
      AND started_at >= v_started_at
  ) THEN
    RETURN false;
  END IF;

  UPDATE inventory_import_runs
  SET
    status = 'FAILED',
    error = p_error,
    finished_at = v_now
  WHERE id = p_import_run_id
    AND connection_id = p_connection_id
    AND status = 'RUNNING';

  UPDATE data_connections
  SET
    status = 'ERROR',
    last_error = p_error,
    updated_at = v_now
  WHERE id = p_connection_id;

  RETURN true;
END;
$$;