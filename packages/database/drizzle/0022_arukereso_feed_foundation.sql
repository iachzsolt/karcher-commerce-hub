CREATE TYPE "public"."feed_decision" AS ENUM('INCLUDED', 'REVIEW', 'EXCLUDED');--> statement-breakpoint
CREATE TYPE "public"."feed_inclusion_mode" AS ENUM('INHERIT', 'FORCE_INCLUDE', 'FORCE_EXCLUDE');--> statement-breakpoint
CREATE TABLE "catalog_source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"product_id" uuid,
	"source_item_key" text NOT NULL,
	"identifier" text,
	"ean_code" text,
	"manufacturer" text,
	"name" text,
	"description" text,
	"category" text,
	"product_url" text,
	"image_url" text,
	"image_url_2" text,
	"additional_image_urls_json" text DEFAULT '[]' NOT NULL,
	"source_fingerprint" text,
	"raw_data_json" text,
	"match_status" text DEFAULT 'UNMATCHED' NOT NULL,
	"match_error" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_channel_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"role" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"target_country" text NOT NULL,
	"content_language" text NOT NULL,
	"currency" text NOT NULL,
	"format" text NOT NULL,
	"delivery_mode" text,
	"external_channel_id" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'NOT_CONFIGURED' NOT NULL,
	"settings_json" text DEFAULT '{}' NOT NULL,
	"last_successful_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_product_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"inclusion_mode" "feed_inclusion_mode" DEFAULT 'INHERIT' NOT NULL,
	"external_item_id" text,
	"price_override_minor" integer,
	"net_price_override_minor" integer,
	"delivery_cost_override_minor" integer,
	"delivery_time_override_days" integer,
	"attributes_json" text,
	"reason" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_run_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"product_id" uuid,
	"item_index" integer,
	"external_item_id" text,
	"sku" text NOT NULL,
	"identifier" text,
	"ean_code" text,
	"name" text,
	"decision" "feed_decision" NOT NULL,
	"reason_codes_json" text NOT NULL,
	"stock" integer,
	"price_minor" integer,
	"net_price_minor" integer,
	"delivery_cost_minor" integer,
	"delivery_time_days" integer,
	"currency" text,
	"manual_override_applied" boolean DEFAULT false NOT NULL,
	"input_snapshot_json" text NOT NULL,
	"override_snapshot_json" text,
	"decision_details_json" text NOT NULL,
	"resolved_item_json" text,
	"payload_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"trigger_type" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"generator_version" text,
	"rule_version" text,
	"items_evaluated" integer DEFAULT 0 NOT NULL,
	"items_included" integer DEFAULT 0 NOT NULL,
	"items_review" integer DEFAULT 0 NOT NULL,
	"items_excluded" integer DEFAULT 0 NOT NULL,
	"items_failed" integer DEFAULT 0 NOT NULL,
	"input_fingerprint" text,
	"output_fingerprint" text,
	"channel_snapshot_json" text NOT NULL,
	"source_snapshot_json" text NOT NULL,
	"rule_snapshot_json" text NOT NULL,
	"artifact_file_name" text,
	"artifact_content_type" text,
	"artifact_fingerprint" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricing_source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"product_id" uuid,
	"source_item_key" text NOT NULL,
	"identifier" text,
	"market_code" text NOT NULL,
	"currency" text NOT NULL,
	"own_price_minor" integer,
	"effective_price_minor" integer,
	"market_minimum_price_minor" integer,
	"market_average_price_minor" integer,
	"market_median_price_minor" integer,
	"price_difference_bps" integer,
	"price_index_bps" integer,
	"median_index_bps" integer,
	"average_index_bps" integer,
	"price_position" integer,
	"offer_count" integer,
	"dealer_minimum_price_minor" integer,
	"dealer_median_price_minor" integer,
	"dealer_index_bps" integer,
	"retail_minimum_price_minor" integer,
	"retail_median_price_minor" integer,
	"retail_index_bps" integer,
	"promotion_active" boolean,
	"promotion_name" text,
	"promotion_price_minor" integer,
	"promotion_starts_at" timestamp with time zone,
	"promotion_ends_at" timestamp with time zone,
	"promotion_json" text,
	"data_status" text DEFAULT 'UNKNOWN' NOT NULL,
	"source_fingerprint" text,
	"raw_data_json" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog_source_items" ADD CONSTRAINT "catalog_source_items_connection_id_data_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."data_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog_source_items" ADD CONSTRAINT "catalog_source_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_channel_sources" ADD CONSTRAINT "feed_channel_sources_channel_id_feed_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."feed_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_channel_sources" ADD CONSTRAINT "feed_channel_sources_connection_id_data_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."data_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_channels" ADD CONSTRAINT "feed_channels_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_product_overrides" ADD CONSTRAINT "feed_product_overrides_channel_id_feed_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."feed_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_product_overrides" ADD CONSTRAINT "feed_product_overrides_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_run_items" ADD CONSTRAINT "feed_run_items_run_id_feed_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."feed_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_run_items" ADD CONSTRAINT "feed_run_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_runs" ADD CONSTRAINT "feed_runs_channel_id_feed_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."feed_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_source_items" ADD CONSTRAINT "pricing_source_items_connection_id_data_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."data_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_source_items" ADD CONSTRAINT "pricing_source_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_source_items_connection_key_unique" ON "catalog_source_items" USING btree ("connection_id","source_item_key");--> statement-breakpoint
CREATE INDEX "catalog_source_items_connection_index" ON "catalog_source_items" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "catalog_source_items_product_index" ON "catalog_source_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "catalog_source_items_identifier_index" ON "catalog_source_items" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "catalog_source_items_ean_index" ON "catalog_source_items" USING btree ("ean_code");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_channel_source_unique" ON "feed_channel_sources" USING btree ("channel_id","connection_id","role");--> statement-breakpoint
CREATE INDEX "feed_channel_sources_channel_role_index" ON "feed_channel_sources" USING btree ("channel_id","role","priority");--> statement-breakpoint
CREATE INDEX "feed_channel_sources_connection_index" ON "feed_channel_sources" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_channels_platform_code_unique" ON "feed_channels" USING btree ("platform_id","code");--> statement-breakpoint
CREATE INDEX "feed_channels_platform_index" ON "feed_channels" USING btree ("platform_id");--> statement-breakpoint
CREATE INDEX "feed_channels_active_index" ON "feed_channels" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_product_override_unique" ON "feed_product_overrides" USING btree ("channel_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_product_override_external_unique" ON "feed_product_overrides" USING btree ("channel_id","external_item_id");--> statement-breakpoint
CREATE INDEX "feed_product_overrides_product_index" ON "feed_product_overrides" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_run_item_unique" ON "feed_run_items" USING btree ("run_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "feed_run_item_external_unique" ON "feed_run_items" USING btree ("run_id","external_item_id");--> statement-breakpoint
CREATE INDEX "feed_run_items_product_index" ON "feed_run_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "feed_run_items_run_decision_index" ON "feed_run_items" USING btree ("run_id","decision");--> statement-breakpoint
CREATE INDEX "feed_runs_channel_started_index" ON "feed_runs" USING btree ("channel_id","started_at");--> statement-breakpoint
CREATE INDEX "feed_runs_status_index" ON "feed_runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "pricing_source_items_scope_unique" ON "pricing_source_items" USING btree ("connection_id","source_item_key","market_code","currency");--> statement-breakpoint
CREATE INDEX "pricing_source_items_connection_index" ON "pricing_source_items" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "pricing_source_items_product_index" ON "pricing_source_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "pricing_source_items_identifier_index" ON "pricing_source_items" USING btree ("identifier");
