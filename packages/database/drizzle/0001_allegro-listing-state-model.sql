CREATE TYPE "public"."campaign_type" AS ENUM('STANDARD', 'DISCOUNT', 'SOURCING', 'OTHER');--> statement-breakpoint
ALTER TYPE "public"."listing_status" ADD VALUE 'ACTIVATING' BEFORE 'INACTIVE';--> statement-breakpoint
CREATE TABLE "listing_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"external_campaign_id" text NOT NULL,
	"campaign_name" text,
	"campaign_type" "campaign_type" DEFAULT 'OTHER' NOT NULL,
	"marketplace" text,
	"desired_price_minor" integer,
	"remote_price_minor" integer,
	"reference_price_minor" integer,
	"dedicated_stock" integer,
	"price_locked" boolean DEFAULT false NOT NULL,
	"auto_sync" boolean DEFAULT false NOT NULL,
	"application_status" text,
	"campaign_status" text,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_desired_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"list_price_minor" integer,
	"regular_price_minor" integer,
	"desired_stock" integer,
	"desired_publication_status" "listing_status" DEFAULT 'UNKNOWN' NOT NULL,
	"price_locked" boolean DEFAULT false NOT NULL,
	"stock_locked" boolean DEFAULT false NOT NULL,
	"auto_price_sync" boolean DEFAULT false NOT NULL,
	"auto_stock_sync" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_remote_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"price_minor" integer,
	"currency" text DEFAULT 'HUF' NOT NULL,
	"stock_available" integer,
	"stock_sold" integer,
	"publication_status" "listing_status" DEFAULT 'UNKNOWN' NOT NULL,
	"publication_starting_at" timestamp with time zone,
	"publication_ending_at" timestamp with time zone,
	"price_automation_rule_id" text,
	"price_automation_rule_type" text,
	"is_fulfillment" boolean DEFAULT false NOT NULL,
	"source_updated_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"external_account_id" text,
	"marketplace" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "platform_listing_unique";--> statement-breakpoint
ALTER TABLE "platform_listings" ADD COLUMN "account_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_listings" ADD COLUMN "external_reference" text;--> statement-breakpoint
ALTER TABLE "platform_listings" ADD COLUMN "category_id" text;--> statement-breakpoint
ALTER TABLE "platform_listings" ADD COLUMN "listing_name" text;--> statement-breakpoint
ALTER TABLE "listing_campaigns" ADD CONSTRAINT "listing_campaigns_listing_id_platform_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."platform_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_desired_states" ADD CONSTRAINT "listing_desired_states_listing_id_platform_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."platform_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_remote_states" ADD CONSTRAINT "listing_remote_states_listing_id_platform_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."platform_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "listing_campaign_unique" ON "listing_campaigns" USING btree ("listing_id","external_campaign_id");--> statement-breakpoint
CREATE INDEX "listing_campaigns_listing_index" ON "listing_campaigns" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_desired_state_unique" ON "listing_desired_states" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_remote_state_unique" ON "listing_remote_states" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_account_unique" ON "platform_accounts" USING btree ("platform_id","code");--> statement-breakpoint
ALTER TABLE "platform_listings" ADD CONSTRAINT "platform_listings_account_id_platform_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."platform_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_listing_unique" ON "platform_listings" USING btree ("platform_id","account_id","external_listing_id");--> statement-breakpoint
ALTER TABLE "platform_listings" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "platform_listings" DROP COLUMN "current_price_minor";--> statement-breakpoint
ALTER TABLE "platform_listings" DROP COLUMN "current_stock";--> statement-breakpoint
ALTER TABLE "platform_listings" DROP COLUMN "currency";--> statement-breakpoint
ALTER TABLE "platform_listings" DROP COLUMN "last_synced_at";