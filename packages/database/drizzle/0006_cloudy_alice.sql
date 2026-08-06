ALTER TABLE "listing_campaigns" ADD COLUMN "retry_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "listing_campaigns" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;