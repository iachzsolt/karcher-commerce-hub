CREATE TABLE "data_connection_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"trigger_type" text DEFAULT 'SCHEDULED' NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"import_status" text,
	"rows_imported" integer DEFAULT 0 NOT NULL,
	"changed_item_count" integer DEFAULT 0 NOT NULL,
	"listings" integer DEFAULT 0 NOT NULL,
	"batch_count" integer DEFAULT 0 NOT NULL,
	"failed_batch_count" integer DEFAULT 0 NOT NULL,
	"selected" integer DEFAULT 0 NOT NULL,
	"attempted" integer DEFAULT 0 NOT NULL,
	"stock_updated" integer DEFAULT 0 NOT NULL,
	"auto_paused" integer DEFAULT 0 NOT NULL,
	"reactivated" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"pending" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "data_connection_runs" ADD CONSTRAINT "data_connection_runs_connection_id_data_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."data_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_connection_runs_connection_started_index" ON "data_connection_runs" USING btree ("connection_id","started_at");--> statement-breakpoint
CREATE INDEX "data_connection_runs_status_index" ON "data_connection_runs" USING btree ("status");