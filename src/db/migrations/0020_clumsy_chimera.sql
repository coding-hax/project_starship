CREATE TABLE "auth_rate_limits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_rate_limits_bucket_key_window_idx" ON "auth_rate_limits" USING btree ("bucket","key","window_start");--> statement-breakpoint
CREATE INDEX "auth_rate_limits_window_start_idx" ON "auth_rate_limits" USING btree ("window_start");