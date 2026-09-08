-- Down path for 0025_needy_hobgoblin.sql (issue #1103).
-- last_seen_at comes back alive this time — requireOwner() writes it through a
-- throttled UPDATE (AC3). Dropping it only loses the "zuletzt gesehen" display,
-- never a session's validity.
ALTER TABLE "sessions" DROP COLUMN "last_seen_at";
