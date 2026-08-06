CREATE TABLE "listing_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" text DEFAULT 'HUF' NOT NULL,
	"source" text DEFAULT 'ALLEGRO_SYNC' NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing_price_history" ADD CONSTRAINT "listing_price_history_listing_id_platform_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."platform_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_price_history_listing_observed_index" ON "listing_price_history" USING btree ("listing_id","observed_at");