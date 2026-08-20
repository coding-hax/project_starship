import { toDateKey } from './due-today';
import { dayBefore, isDoneOnDay, isTargetMet, periodRangeFor } from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * Consecutive days with `done` counting back from today. Today being still
 * open does not break the streak — only an actually skipped day does — so an
 * open today falls back to counting from yesterday (issue #104).
 */
function dailyStreak(habitId: string, logs: HabitLogView[], now: Date): number {
  let cursor = isDoneOnDay(logs, habitId, toDateKey(now)) ? now : addDays(now, -1);
  let streak = 0;
  while (isDoneOnDay(logs, habitId, toDateKey(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/**
 * Consecutive periods (Mon–Sun week, fortnight, month, quarter, year — whatever
 * `habit.schedule` uses) with `target` reached, counting back from the period
 * containing `now`. Same "the running period may still be open" rule as
 * `dailyStreak`: an unmet-so-far current period doesn't break the streak, it
 * just isn't counted yet — only an actually missed earlier period does
 * (issue #104, generalized by #509).
 */
function periodStreak(
  habit: Pick<HabitView, 'id' | 'schedule' | 'target'>,
  logs: HabitLogView[],
  now: Date,
): number {
  let dateKey = toDateKey(now);
  let range = periodRangeFor(habit, dateKey);
  if (!isTargetMet(habit, logs, range)) {
    dateKey = dayBefore(range.start);
    range = periodRangeFor(habit, dateKey);
  }

  let streak = 0;
  while (isTargetMet(habit, logs, range)) {
    streak += 1;
    dateKey = dayBefore(range.start);
    range = periodRangeFor(habit, dateKey);
  }
  return streak;
}

/**
 * Current streak for a habit: consecutive days for daily/custom (custom has
 * no due-logic of its own yet, see due-today.ts), consecutive periods for
 * every other schedule (issue #509). Day/period boundaries are the local
 * calendar (issue #104).
 */
export function computeStreak(
  habit: Pick<HabitView, 'id' | 'schedule' | 'target'>,
  logs: HabitLogView[],
  now: Date = new Date(),
): number {
  const isDayBased = habit.schedule === 'daily' || habit.schedule === 'custom';
  return isDayBased ? dailyStreak(habit.id, logs, now) : periodStreak(habit, logs, now);
}

/** Number of non-archived habits with a running streak (issue #809). */
export function countHabitsOnStreak(
  habits: HabitView[],
  logs: HabitLogView[],
  now: Date = new Date(),
): number {
  return habits.filter((habit) => habit.archivedAt === null && computeStreak(habit, logs, now) > 0)
    .length;
}
