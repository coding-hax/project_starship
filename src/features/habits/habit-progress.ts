import { metEarlierInPeriod, toDateKey } from './due-today';
import { isDoneOnDay } from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

export interface HabitProgress {
  done: number;
  total: number;
}

/**
 * "N von M" fällige Routinen heute — extracted from `daily-progress.ts`'s
 * Routinen-Zweig (issue #972) so the progress ring and the Routinen card head
 * link share one count instead of drifting apart. Archived habits never
 * count; a habit whose `target` was already reached on an earlier day of its
 * running period drops out of both numbers (issue #503/#509,
 * `metEarlierInPeriod`).
 */
export function computeHabitProgress(
  habits: HabitView[],
  logs: HabitLogView[],
  now: Date = new Date(),
): HabitProgress {
  const dateKey = toDateKey(now);
  const dueHabits = habits.filter(
    (habit) => habit.archivedAt === null && !metEarlierInPeriod(habit, logs, now),
  );
  const done = dueHabits.filter((habit) => isDoneOnDay(logs, habit.id, dateKey)).length;

  return { done, total: dueHabits.length };
}
