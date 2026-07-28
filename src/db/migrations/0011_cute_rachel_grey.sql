CREATE TABLE "reminder_prefs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"times" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "reminder_prefs_updated_at_idx" ON "reminder_prefs" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "reminder_prefs_sync_seq_idx" ON "reminder_prefs" USING btree ("sync_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_prefs_kind_idx" ON "reminder_prefs" USING btree ("kind");