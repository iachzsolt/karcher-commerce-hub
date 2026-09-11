CREATE TABLE "feed_access_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"day" date NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"last_requested_at" timestamp with time zone,
	"last_served_run_id" uuid,
	"last_user_agent" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feed_access_daily" ADD CONSTRAINT "feed_access_daily_channel_id_feed_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."feed_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_access_daily" ADD CONSTRAINT "feed_access_daily_last_served_run_id_feed_runs_id_fk" FOREIGN KEY ("last_served_run_id") REFERENCES "public"."feed_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_access_daily_channel_day_unique" ON "feed_access_daily" USING btree ("channel_id","day");