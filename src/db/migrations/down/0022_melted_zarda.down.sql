-- Down path for 0022_melted_zarda.sql (issue #857).
-- last_seen_at was a dead column — nothing ever wrote to it (the auth
-- middleware only checks cookie presence, no DB access, #599). Restoring it
-- recreates the exact prior state: nullable, no default.
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" timestamp with time zone;
