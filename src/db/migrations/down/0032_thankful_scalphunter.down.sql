-- Down path for 0032_thankful_scalphunter.sql (#1233).
-- user_activity_windows is server-infra like user_activity_days/admin_audit —
-- no account content lives here, so dropping it loses nothing but the 30-day
-- Neon-wake-time history. user_activity_days (unaffected, already existed)
-- still answers "aktive Tage" on its own.
DROP TABLE "user_activity_windows";
