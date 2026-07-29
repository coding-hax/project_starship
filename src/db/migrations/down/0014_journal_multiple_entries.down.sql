-- Down path for 0014_steep_james_howlett.sql (issue #376).
-- Restores the pre-#376 shape: one entry per day, entry_date unique again, no
-- created_at column. Only safe if the data still satisfies that invariant --
-- see the up-path migration for context (multiple entries per day is now the norm).
DROP INDEX "journal_entries_entry_date_idx";--> statement-breakpoint
DROP INDEX "journal_entries_created_at_idx";--> statement-breakpoint
ALTER TABLE "journal_entries" DROP COLUMN "created_at";--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_entry_date_idx" ON "journal_entries" USING btree ("entry_date");
