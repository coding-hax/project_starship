-- Down path for 0024_swift_revanche.sql (issue #1101).
-- Purely additive: dropping "emoji" loses only the routine's emoji marker,
-- never habits or habit_logs. "color" is untouched either way.
ALTER TABLE "habits" DROP COLUMN "emoji";
