CREATE TABLE "data_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"source_type" text NOT NULL,
	"purpose" text DEFAULT 'INVENTORY' NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'NOT_CONFIGURED' NOT NULL,
	"last_successful_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_connection_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"spreadsheet_url" text,
	"sheet_name" text NOT NULL,
	"header_row" integer DEFAULT 1 NOT NULL,
	"sku_source_field" text NOT NULL,
	"stock_source_field" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"rows_read" integer DEFAULT 0 NOT NULL,
	"rows_imported" integer DEFAULT 0 NOT NULL,
	"rows_normalized_to_zero" integer DEFAULT 0 NOT NULL,
	"duplicate_sku_count" integer DEFAULT 0 NOT NULL,
	"changed_item_count" integer DEFAULT 0 NOT NULL,
	"source_fingerprint" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inventory_source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"stock" integer DEFAULT 0 NOT NULL,
	"source_stock_value" text,
	"normalized_to_zero" boolean DEFAULT false NOT NULL,
	"last_import_run_id" uuid,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_connection_configs" ADD CONSTRAINT "inventory_connection_configs_connection_id_data_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."data_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_import_runs" ADD CONSTRAINT "inventory_import_runs_connection_id_data_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."data_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_source_items" ADD CONSTRAINT "inventory_source_items_connection_id_data_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."data_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_source_items" ADD CONSTRAINT "inventory_source_items_last_import_run_id_inventory_import_runs_id_fk" FOREIGN KEY ("last_import_run_id") REFERENCES "public"."inventory_import_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "data_connections_purpose_index" ON "data_connections" USING btree ("purpose");--> statement-breakpoint
CREATE INDEX "data_connections_source_type_index" ON "data_connections" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "data_connections_active_index" ON "data_connections" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_connection_config_unique" ON "inventory_connection_configs" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "inventory_import_runs_connection_index" ON "inventory_import_runs" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "inventory_import_runs_started_index" ON "inventory_import_runs" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_source_item_unique" ON "inventory_source_items" USING btree ("connection_id","sku");--> statement-breakpoint
CREATE INDEX "inventory_source_items_sku_index" ON "inventory_source_items" USING btree ("sku");--> statement-breakpoint
CREATE INDEX "inventory_source_items_connection_index" ON "inventory_source_items" USING btree ("connection_id");