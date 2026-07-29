DROP INDEX "journal_entries_entry_date_idx";--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "journal_entries_created_at_idx" ON "journal_entries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "journal_entries_entry_date_idx" ON "journal_entries" USING btree ("entry_date");