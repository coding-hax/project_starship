import { currentWeekRange } from './due-today';
import { doneCountInPeriod } from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

/** Daily/custom have no weekly period of their own (periodRangeFor treats them
 * as one-day periods) but still carry a 7-day Wochensoll — same day-based
 * grouping streak.ts uses for its own daily/custom split. */
function isDayBased(schedule: HabitView['schedule']): boolean {
  return schedule === 'daily' || schedule === 'custom';
}

function countsTowardWeek(habit: Pick<HabitView, 'schedule'>): boolean {
  return isDayBased(habit.schedule) || habit.schedule === 'weekly';
}

function weeklyExpectation(habit: Pick<HabitView, 'schedule' | 'target'>): number {
  return isDayBased(habit.schedule) ? 7 : habit.target;
}

/**
 * Wochensoll Mo–So (issue #905): sum of every non-archived habit's weekly
 * expectation, `daily`/`custom` counting 7 and `weekly` counting its own
 * `target`. `biweekly` and longer periods count 0 — they have no weekly Soll,
 * and prorating one would fake a precision the schedule doesn't have.
 */
export function weekGoal(habits: HabitView[]): number {
  return habits
    .filter((habit) => habit.archivedAt === null && countsTowardWeek(habit))
    .reduce((sum, habit) => sum + weeklyExpectation(habit), 0);
}

/** Erledigungen Mo–So (issue #905) — same habit set `weekGoal` counts, over the
 * Mon–Sun week containing `now`. */
export function weekDone(
  habits: HabitView[],
  logs: HabitLogView[],
  now: Date = new Date(),
): number {
  const range = currentWeekRange(now);
  return habits
    .filter((habit) => habit.archivedAt === null && countsTowardWeek(habit))
    .reduce((sum, habit) => sum + doneCountInPeriod(logs, habit.id, range), 0);
}
