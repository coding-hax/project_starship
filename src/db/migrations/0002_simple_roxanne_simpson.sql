CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"title" text NOT NULL,
	"notes" text,
	"due_at" timestamp with time zone,
	"priority" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"recurrence_rule" text
);
--> statement-breakpoint
CREATE INDEX "tasks_updated_at_idx" ON "tasks" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "tasks_due_at_idx" ON "tasks" USING btree ("due_at");