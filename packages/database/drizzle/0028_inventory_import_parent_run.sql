ALTER TABLE inventory_import_runs
ADD COLUMN parent_run_id uuid;

ALTER TABLE inventory_import_runs
ADD CONSTRAINT inventory_import_runs_parent_run_fk
FOREIGN KEY (parent_run_id)
REFERENCES data_connection_runs(id)
ON DELETE SET NULL;

CREATE INDEX inventory_import_runs_parent_index
ON inventory_import_runs(parent_run_id);