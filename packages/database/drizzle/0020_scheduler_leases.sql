CREATE TABLE "scheduler_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "scheduler_leases_locked_until_index" ON "scheduler_leases" USING btree ("locked_until");
