CREATE TABLE "listing_price_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"promotional_price_minor" integer NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"start_applied_at" timestamp with time zone,
	"end_applied_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing_price_schedules" ADD CONSTRAINT "listing_price_schedules_listing_id_platform_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."platform_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_price_schedules_listing_index" ON "listing_price_schedules" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "listing_price_schedules_period_index" ON "listing_price_schedules" USING btree ("valid_from","valid_to");--> statement-breakpoint
CREATE INDEX "listing_price_schedules_enabled_index" ON "listing_price_schedules" USING btree ("enabled");