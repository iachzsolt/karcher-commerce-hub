CREATE TABLE "allegro_change_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"source" text DEFAULT 'ALLEGRO_SYNC' NOT NULL,
	"old_value" text,
	"new_value" text,
	"currency" text,
	"external_campaign_id" text,
	"metadata_json" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allegro_change_events" ADD CONSTRAINT "allegro_change_events_listing_id_platform_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."platform_listings"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "allegro_change_events_occurred_index" ON "allegro_change_events" USING btree ("occurred_at");
--> statement-breakpoint
CREATE INDEX "allegro_change_events_listing_index" ON "allegro_change_events" USING btree ("listing_id");
--> statement-breakpoint
CREATE INDEX "allegro_change_events_type_index" ON "allegro_change_events" USING btree ("event_type");
--> statement-breakpoint
WITH "recent_price_history" AS (
	SELECT
		"listing_id",
		"price_minor",
		"currency",
		"source",
		"external_campaign_id",
		"observed_at",
		lag("price_minor") OVER (
			PARTITION BY "listing_id"
			ORDER BY "observed_at"
		) AS "previous_price_minor"
	FROM "listing_price_history"
	WHERE "observed_at" >= now() - interval '31 days'
)
INSERT INTO "allegro_change_events" (
	"listing_id",
	"event_type",
	"source",
	"old_value",
	"new_value",
	"currency",
	"external_campaign_id",
	"occurred_at"
)
SELECT
	"listing_id",
	'PRICE',
	"source",
	"previous_price_minor"::text,
	"price_minor"::text,
	"currency",
	"external_campaign_id",
	"observed_at"
FROM "recent_price_history"
WHERE
	"previous_price_minor" IS NOT NULL
	AND "previous_price_minor" <> "price_minor"
	AND "observed_at" >= now() - interval '30 days';
