CREATE TYPE "public"."listing_status" AS ENUM('ACTIVE', 'INACTIVE', 'ENDED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."product_identifier_type" AS ENUM('EAN', 'MANUFACTURER_SKU', 'SAP_ID', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."product_line" AS ENUM('HG', 'PROFESSIONAL', 'UNASSIGNED');--> statement-breakpoint
CREATE TABLE "platform_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"platform_id" uuid NOT NULL,
	"external_listing_id" text NOT NULL,
	"external_product_id" text,
	"marketplace" text,
	"status" "listing_status" DEFAULT 'UNKNOWN' NOT NULL,
	"current_price_minor" integer,
	"current_stock" integer,
	"currency" text DEFAULT 'HUF' NOT NULL,
	"listing_url" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platforms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"type" "product_identifier_type" NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"product_line" "product_line" DEFAULT 'UNASSIGNED' NOT NULL,
	"category" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_listings" ADD CONSTRAINT "platform_listings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_listings" ADD CONSTRAINT "platform_listings_platform_id_platforms_id_fk" FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_identifiers" ADD CONSTRAINT "product_identifiers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_listing_unique" ON "platform_listings" USING btree ("platform_id","external_listing_id");--> statement-breakpoint
CREATE INDEX "platform_listings_product_index" ON "platform_listings" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platforms_code_unique" ON "platforms" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "product_identifier_unique" ON "product_identifiers" USING btree ("type","value");--> statement-breakpoint
CREATE INDEX "product_identifiers_product_index" ON "product_identifiers" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_sku_unique" ON "products" USING btree ("sku");