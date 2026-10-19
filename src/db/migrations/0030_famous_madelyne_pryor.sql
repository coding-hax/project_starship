CREATE TABLE "admin_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text,
	"target_user_id" uuid,
	"target_label" text,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_created_at_idx" ON "admin_audit" USING btree ("created_at");