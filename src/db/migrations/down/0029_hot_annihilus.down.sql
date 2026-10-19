-- Down path for 0029_hot_annihilus.sql (#1203, S4).
-- user_activity_days is server-infra like sessions/invites/reminder_sends — no
-- account content lives here, so dropping it loses nothing but the "aktive Tage
-- in 30" history. users.last_seen_at (unaffected, already existed) still answers
-- "zuletzt aktiv" on its own.
DROP TABLE "user_activity_days";
