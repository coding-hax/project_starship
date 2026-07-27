-- Down path for 0010_careless_killraven.sql (issue #239).
-- drizzle-kit only ever generates and applies "up" migrations — this file follows the
-- `migrations/down/` convention established by #186. reminder_sends is cron
-- infrastructure like garmin_tokens/push_subscriptions: nothing references it
-- (no FK, not sync-managed), so dropping it is safe on its own.
DROP TABLE "reminder_sends";
