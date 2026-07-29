CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_seq" bigint NOT NULL,
	"entry_date" date NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_seq" bigint NOT NULL,
	"envelope" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "journal_entries_updated_at_idx" ON "journal_entries" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "journal_entries_sync_seq_idx" ON "journal_entries" USING btree ("sync_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_entry_date_idx" ON "journal_entries" USING btree ("entry_date");--> statement-breakpoint
CREATE INDEX "journal_keys_updated_at_idx" ON "journal_keys" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "journal_keys_sync_seq_idx" ON "journal_keys" USING btree ("sync_seq");