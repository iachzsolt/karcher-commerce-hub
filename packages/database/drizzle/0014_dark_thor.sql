CREATE TABLE "data_connection_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'DAILY_TIMES' NOT NULL,
	"interval_minutes" integer,
	"daily_times_json" text DEFAULT '[]' NOT NULL,
	"time_zone" text DEFAULT 'Europe/Budapest' NOT NULL,
	"weekdays_only" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_connection_schedules" ADD CONSTRAINT "data_connection_schedules_connection_id_data_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."data_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_connection_schedule_unique" ON "data_connection_schedules" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "data_connection_schedule_enabled_index" ON "data_connection_schedules" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "data_connection_schedule_next_run_index" ON "data_connection_schedules" USING btree ("next_run_at");