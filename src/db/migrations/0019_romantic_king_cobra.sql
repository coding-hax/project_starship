CREATE TABLE "category_colors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_seq" bigint NOT NULL,
	"category" text NOT NULL,
	"color" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "category_colors_updated_at_idx" ON "category_colors" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "category_colors_sync_seq_idx" ON "category_colors" USING btree ("sync_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "category_colors_category_idx" ON "category_colors" USING btree ("category");