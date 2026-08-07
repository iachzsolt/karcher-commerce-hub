CREATE TABLE "listing_accepted_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"accepted_price_minor" integer,
	"accepted_stock_available" integer,
	"accepted_publication_status" "listing_status" DEFAULT 'UNKNOWN' NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing_accepted_states" ADD CONSTRAINT "listing_accepted_states_listing_id_platform_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."platform_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_accepted_state_unique" ON "listing_accepted_states" USING btree ("listing_id");
--> statement-breakpoint
INSERT INTO "listing_accepted_states" (
  "listing_id",
  "accepted_price_minor",
  "accepted_stock_available",
  "accepted_publication_status",
  "accepted_at",
  "updated_at"
)
SELECT
  "listing_id",
  "price_minor",
  "stock_available",
  "publication_status",
  now(),
  now()
FROM "listing_remote_states"
ON CONFLICT ("listing_id") DO NOTHING;
