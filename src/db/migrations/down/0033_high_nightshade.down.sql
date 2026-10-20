-- Down path for 0033_high_nightshade.sql (#1235).
-- account_sync_counters is server-infra like user_activity_days/
-- user_activity_windows — no account content lives here, so dropping it only
-- loses the 30-day sync/push-failure counts. sessions.app_version is likewise
-- a derived label, not content.
DROP TABLE "account_sync_counters";
ALTER TABLE "sessions" DROP COLUMN "app_version";
