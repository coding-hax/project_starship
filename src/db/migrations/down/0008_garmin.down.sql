-- Down path for 0008_nappy_titania.sql (issue #186).
-- drizzle-kit only ever generates and applies "up" migrations — this file, and the
-- `migrations/down/` convention it establishes, is applied by hand if #186 needs to
-- be rolled back. Nothing else in the schema references these tables (no FK, no
-- UI yet — that lands in #180), so dropping them is safe on its own.
DROP TABLE "garmin_activities";
DROP TABLE "garmin_tokens";
