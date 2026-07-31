import { currentWeekRange, toDateKey } from './due-today';
import { isDoneInWeek, isDoneOnDay, isFrozenOnDay } from './schedule-rules';
import type { HabitFreezeView } from './use-habit-freezes';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** A day counts toward a daily/custom streak if it was done, or bridged by a joker. */
function isCoveredOnDay(
  logs: HabitLogView[],
  freezes: HabitFreezeView[],
  habitId: string,
  dateKey: string,
): boolean {
  return isDoneOnDay(logs, habitId, dateKey) || isFrozenOnDay(freezes, habitId, dateKey);
}

/**
 * Consecutive days with `done` (or a streak-joker freeze, issue #433) counting
 * back from today. Today being still open does not break the streak — only an
 * actually skipped, unfrozen day does — so an open today falls back to
 * counting from yesterday (issue #104).
 */
function dailyStreak(
  habitId: string,
  logs: HabitLogView[],
  freezes: HabitFreezeView[],
  now: Date,
): number {
  let cursor = isCoveredOnDay(logs, freezes, habitId, toDateKey(now)) ? now : addDays(now, -1);
  let streak = 0;
  while (isCoveredOnDay(logs, freezes, habitId, toDateKey(cursor))) {
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
 *
 * `freezes` is a required parameter (not a defaulted `[]`) so TypeScript forces
 * every caller to pass its own habit_freezes read — a silent default would hide
 * a caller that forgot to wire the streak-joker up (issue #433). `weekly` never
 * receives it: freezes only bridge daily/custom gaps.
 */
export function computeStreak(
  habit: Pick<HabitView, 'id' | 'schedule'>,
  logs: HabitLogView[],
  freezes: HabitFreezeView[],
  now: Date = new Date(),
): number {
  return habit.schedule === 'weekly'
    ? weeklyStreak(habit.id, logs, now)
    : dailyStreak(habit.id, logs, freezes, now);
}
