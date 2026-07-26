CREATE TABLE "garmin_activities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"sync_seq" bigint NOT NULL,
	"garmin_activity_id" bigint NOT NULL,
	"activity_type" text NOT NULL,
	"name" text,
	"started_at" timestamp with time zone NOT NULL,
	"distance_meters" integer,
	"duration_seconds" integer,
	"elapsed_seconds" integer,
	"elevation_gain" integer,
	"elevation_loss" integer,
	"average_hr" integer,
	"max_hr" integer,
	"average_speed" real,
	"calories" integer,
	"track" jsonb,
	"map_image" text,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "garmin_activities_garmin_activity_id_unique" UNIQUE("garmin_activity_id")
);
--> statement-breakpoint
CREATE TABLE "garmin_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"token" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "garmin_tokens_kind_unique" UNIQUE("kind")
);
--> statement-breakpoint
CREATE INDEX "garmin_activities_updated_at_idx" ON "garmin_activities" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "garmin_activities_sync_seq_idx" ON "garmin_activities" USING btree ("sync_seq");--> statement-breakpoint
CREATE INDEX "garmin_activities_started_at_idx" ON "garmin_activities" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "garmin_activities_garmin_activity_id_idx" ON "garmin_activities" USING btree ("garmin_activity_id");