CREATE TABLE "sync_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	CONSTRAINT "sync_state_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE INDEX "sync_state_updated_at_idx" ON "sync_state" USING btree ("updated_at");