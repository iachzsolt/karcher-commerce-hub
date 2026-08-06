ALTER TABLE "listing_price_history" ADD COLUMN "base_price_minor" integer;--> statement-breakpoint
ALTER TABLE "listing_price_history" ADD COLUMN "price_type" text DEFAULT 'REGULAR' NOT NULL;--> statement-breakpoint
ALTER TABLE "listing_price_history" ADD COLUMN "external_campaign_id" text;--> statement-breakpoint
UPDATE "listing_price_history"
SET "base_price_minor" = "price_minor"
WHERE "base_price_minor" IS NULL;
