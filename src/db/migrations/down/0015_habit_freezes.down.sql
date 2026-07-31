-- Down path for 0015_sticky_junta.sql (issue #433).
-- habit_freezes is purely additive: streaks are computed bitidentical to today
-- when no rows exist. Dropping it removes only the freeze rows, never habits
-- or habit_logs (FK is habit_id -> habits.id, no cascade).
DROP TABLE "habit_freezes";
