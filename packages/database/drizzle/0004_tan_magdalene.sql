CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_campaign_id" text,
	"name" text NOT NULL,
	"campaign_type" "campaign_type" DEFAULT 'OTHER' NOT NULL,
	"marketplace" text,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"auto_sync" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing_campaigns" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
CREATE INDEX "campaigns_marketplace_index" ON "campaigns" USING btree ("marketplace");--> statement-breakpoint
CREATE INDEX "campaigns_status_index" ON "campaigns" USING btree ("status");--> statement-breakpoint
ALTER TABLE "listing_campaigns" ADD CONSTRAINT "listing_campaigns_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;