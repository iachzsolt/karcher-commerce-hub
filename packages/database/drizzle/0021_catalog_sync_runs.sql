CREATE TABLE "catalog_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text DEFAULT 'AUTOMATIC' NOT NULL,
	"status" text NOT NULL,
	"total_offers" integer DEFAULT 0 NOT NULL,
	"new_offers" integer DEFAULT 0 NOT NULL,
	"renamed_offers" integer DEFAULT 0 NOT NULL,
	"offers_without_sku" integer DEFAULT 0 NOT NULL,
	"synced_offers" integer DEFAULT 0 NOT NULL,
	"initialized_baselines" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "catalog_sync_runs_started_at_index" ON "catalog_sync_runs" USING btree ("started_at");
