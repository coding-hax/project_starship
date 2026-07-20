CREATE TABLE "habit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_seq" bigint NOT NULL,
	"habit_id" uuid NOT NULL,
	"log_date" date NOT NULL,
	"done" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "habits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_seq" bigint NOT NULL,
	"name" text NOT NULL,
	"schedule" text NOT NULL,
	"color" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "habit_logs" ADD CONSTRAINT "habit_logs_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "habit_logs_updated_at_idx" ON "habit_logs" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "habit_logs_sync_seq_idx" ON "habit_logs" USING btree ("sync_seq");--> statement-breakpoint
CREATE INDEX "habit_logs_habit_id_idx" ON "habit_logs" USING btree ("habit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "habit_logs_habit_id_log_date_idx" ON "habit_logs" USING btree ("habit_id","log_date");--> statement-breakpoint
CREATE INDEX "habits_updated_at_idx" ON "habits" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "habits_sync_seq_idx" ON "habits" USING btree ("sync_seq");--> statement-breakpoint
CREATE INDEX "habits_created_at_idx" ON "habits" USING btree ("created_at");