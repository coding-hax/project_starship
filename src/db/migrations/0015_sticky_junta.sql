CREATE TABLE "habit_freezes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_seq" bigint NOT NULL,
	"habit_id" uuid NOT NULL,
	"freeze_date" date NOT NULL
);
--> statement-breakpoint
ALTER TABLE "habit_freezes" ADD CONSTRAINT "habit_freezes_habit_id_habits_id_fk" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "habit_freezes_updated_at_idx" ON "habit_freezes" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "habit_freezes_sync_seq_idx" ON "habit_freezes" USING btree ("sync_seq");--> statement-breakpoint
CREATE INDEX "habit_freezes_habit_id_idx" ON "habit_freezes" USING btree ("habit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "habit_freezes_habit_id_freeze_date_idx" ON "habit_freezes" USING btree ("habit_id","freeze_date");