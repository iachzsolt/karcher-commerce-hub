CREATE TABLE "platform_inventory_sync_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"trigger_mode" text DEFAULT 'INVENTORY_REFRESH' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_inventory_sync_settings" ADD CONSTRAINT "platform_inventory_sync_settings_account_id_platform_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."platform_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_inventory_sync_settings_account_unique" ON "platform_inventory_sync_settings" USING btree ("account_id");