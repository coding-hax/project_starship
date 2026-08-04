CREATE TABLE "event_exceptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_seq" bigint NOT NULL,
	"event_id" uuid NOT NULL,
	"original_date" date NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	"override_starts_at" timestamp with time zone,
	"override_ends_at" timestamp with time zone,
	"override_start_date" date,
	"override_end_date" date
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_seq" bigint NOT NULL,
	"title" text NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"start_date" date,
	"end_date" date,
	"category" text,
	"recurrence" jsonb,
	"reminder_minutes" integer
);
--> statement-breakpoint
ALTER TABLE "event_exceptions" ADD CONSTRAINT "event_exceptions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_exceptions_updated_at_idx" ON "event_exceptions" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "event_exceptions_sync_seq_idx" ON "event_exceptions" USING btree ("sync_seq");--> statement-breakpoint
CREATE INDEX "event_exceptions_event_id_idx" ON "event_exceptions" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_exceptions_event_id_original_date_idx" ON "event_exceptions" USING btree ("event_id","original_date");--> statement-breakpoint
CREATE INDEX "events_updated_at_idx" ON "events" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "events_sync_seq_idx" ON "events" USING btree ("sync_seq");--> statement-breakpoint
CREATE INDEX "events_starts_at_idx" ON "events" USING btree ("starts_at");--> statement-breakpoint
CREATE INDEX "events_start_date_idx" ON "events" USING btree ("start_date");