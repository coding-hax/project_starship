CREATE TABLE "user_activity_windows" (
	"user_id" uuid,
	"system_source" text,
	"window_start" timestamp with time zone NOT NULL,
	CONSTRAINT "user_activity_windows_account_xor_system" CHECK (("user_activity_windows"."user_id" is null) <> ("user_activity_windows"."system_source" is null))
);
--> statement-breakpoint
ALTER TABLE "user_activity_windows" ADD CONSTRAINT "user_activity_windows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_activity_windows_account_window_idx" ON "user_activity_windows" USING btree ("user_id","window_start") WHERE "user_activity_windows"."system_source" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "user_activity_windows_system_window_idx" ON "user_activity_windows" USING btree ("system_source","window_start") WHERE "user_activity_windows"."user_id" is null;--> statement-breakpoint
CREATE INDEX "user_activity_windows_window_start_idx" ON "user_activity_windows" USING btree ("window_start");