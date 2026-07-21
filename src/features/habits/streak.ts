import { currentWeekRange, toDateKey } from './due-today';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function isDoneOnDay(logs: HabitLogView[], habitId: string, dateKey: string): boolean {
  return logs.some((log) => log.habitId === habitId && log.logDate === dateKey && log.done);
}

function isDoneInWeek(
  logs: HabitLogView[],
  habitId: string,
  range: { start: string; end: string },
): boolean {
  return logs.some(
    (log) =>
      log.habitId === habitId &&
      log.done &&
      log.logDate >= range.start &&
      log.logDate <= range.end,
  );
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
 * Consecutive Mon–Sun weeks with at least one `done`, counting back from the
 * current week — same "the running period may still be open" rule as
 * `dailyStreak`.
 */
function weeklyStreak(habitId: string, logs: HabitLogView[], now: Date): number {
  let cursor = isDoneInWeek(logs, habitId, currentWeekRange(now)) ? now : addDays(now, -7);
  let streak = 0;
  while (isDoneInWeek(logs, habitId, currentWeekRange(cursor))) {
    streak += 1;
    cursor = addDays(cursor, -7);
  }
  return streak;
}

/**
 * Current streak for a habit: consecutive days for daily/custom (custom has
 * no due-logic of its own yet, see due-today.ts), consecutive Mon–Sun weeks
 * for weekly. Day/week boundaries are the local calendar (issue #104).
 */
export function computeStreak(
  habit: Pick<HabitView, 'id' | 'schedule'>,
  logs: HabitLogView[],
  now: Date = new Date(),
): number {
  return habit.schedule === 'weekly'
    ? weeklyStreak(habit.id, logs, now)
    : dailyStreak(habit.id, logs, now);
}
