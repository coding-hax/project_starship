-- Down path for 0016_solid_doomsday.sql (issue #509).
-- Purely additive: dropping "target" loses only the per-period goal, never
-- habits or habit_logs. The new schedule values ('biweekly', 'monthly',
-- 'quarterly', 'yearly') stay valid text, no CHECK constraint to revert.
ALTER TABLE "habits" DROP COLUMN "target";
