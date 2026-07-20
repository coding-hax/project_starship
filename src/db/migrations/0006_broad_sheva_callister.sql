ALTER TABLE "tasks" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_parent_id_idx" ON "tasks" USING btree ("parent_id");

-- Reverse (down), manual — additive nullable column, safe rollback (issue #89):
-- ALTER TABLE "tasks" DROP CONSTRAINT "tasks_parent_id_tasks_id_fk";
-- DROP INDEX "tasks_parent_id_idx";
-- ALTER TABLE "tasks" DROP COLUMN "parent_id";