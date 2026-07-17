-- Stage 2 of ADR-0008: backfill sync_seq on existing rows, preserving their
-- current relative order (updated_at) per table, then require it going
-- forward. Split from the additive 0003 migration so NOT NULL never lands on
-- a column with unset values.
--
-- A plain `UPDATE ... SET sync_seq = nextval(...)` does not guarantee that
-- nextval() is evaluated in updated_at order — set-based UPDATEs have no
-- defined row-processing order. Instead: reserve a contiguous block of
-- sequence values up front, then assign them by row_number() over
-- updated_at, and finally fast-forward the sequence past the block.
DO $$
DECLARE
  start_seq bigint;
  row_count bigint;
BEGIN
  SELECT count(*) INTO row_count FROM "sync_state" WHERE "sync_seq" IS NULL;
  IF row_count > 0 THEN
    SELECT nextval('"public"."sync_seq"') INTO start_seq;
    PERFORM setval('"public"."sync_seq"', start_seq + row_count - 1, true);
    UPDATE "sync_state" t
    SET "sync_seq" = start_seq + sub.rn - 1
    FROM (
      SELECT "id", row_number() OVER (ORDER BY "updated_at") AS rn
      FROM "sync_state" WHERE "sync_seq" IS NULL
    ) sub
    WHERE t."id" = sub."id";
  END IF;

  SELECT count(*) INTO row_count FROM "tasks" WHERE "sync_seq" IS NULL;
  IF row_count > 0 THEN
    SELECT nextval('"public"."sync_seq"') INTO start_seq;
    PERFORM setval('"public"."sync_seq"', start_seq + row_count - 1, true);
    UPDATE "tasks" t
    SET "sync_seq" = start_seq + sub.rn - 1
    FROM (
      SELECT "id", row_number() OVER (ORDER BY "updated_at") AS rn
      FROM "tasks" WHERE "sync_seq" IS NULL
    ) sub
    WHERE t."id" = sub."id";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "sync_state" ALTER COLUMN "sync_seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "sync_seq" SET NOT NULL;
