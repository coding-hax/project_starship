CREATE SEQUENCE "public"."sync_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "sync_seq" bigint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "sync_seq" bigint;--> statement-breakpoint
CREATE INDEX "sync_state_sync_seq_idx" ON "sync_state" USING btree ("sync_seq");--> statement-breakpoint
CREATE INDEX "tasks_sync_seq_idx" ON "tasks" USING btree ("sync_seq");