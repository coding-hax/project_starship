CREATE TABLE "account_sync_counters" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"rejected_malformed" integer DEFAULT 0 NOT NULL,
	"rejected_missing_required" integer DEFAULT 0 NOT NULL,
	"rejected_constraint" integer DEFAULT 0 NOT NULL,
	"rejected_quota" integer DEFAULT 0 NOT NULL,
	"conflicts" integer DEFAULT 0 NOT NULL,
	"full_pulls" integer DEFAULT 0 NOT NULL,
	"push_subscriptions_dropped" integer DEFAULT 0 NOT NULL,
	"push_delivery_failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "account_sync_counters_user_id_day_pk" PRIMARY KEY("user_id","day")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "app_version" text;--> statement-breakpoint
ALTER TABLE "account_sync_counters" ADD CONSTRAINT "account_sync_counters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;