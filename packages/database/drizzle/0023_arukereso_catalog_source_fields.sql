ALTER TABLE "catalog_source_items" ADD COLUMN "price_minor" integer;--> statement-breakpoint
ALTER TABLE "catalog_source_items" ADD COLUMN "net_price_minor" integer;--> statement-breakpoint
ALTER TABLE "catalog_source_items" ADD COLUMN "delivery_cost_minor" integer;--> statement-breakpoint
ALTER TABLE "catalog_source_items" ADD COLUMN "delivery_time_raw" text;--> statement-breakpoint
ALTER TABLE "catalog_source_items" ADD COLUMN "delivery_time_days" integer;