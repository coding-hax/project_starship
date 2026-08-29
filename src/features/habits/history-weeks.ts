import { toDateKey } from './due-today';
import { addDaysToKey, doneCountInPeriod, periodStatusFor, weekRangeForDay } from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

export interface WeekHistoryEntry {
  done: number;
  due: number;
}

function isDayBased(schedule: HabitView['schedule']): boolean {
  return schedule === 'daily' || schedule === 'custom';
}

/**
 * One week's bar. `daily`/`custom` have no weekly period of their own
 * (`periodRangeFor` treats them as one-day periods), so their due/done is
 * built straight from the Mon–Sun range instead of `periodStatusFor`. Every
 * other schedule reuses `periodStatusFor` for `weekMonday` — for `weekly` that
 * range *is* the Mon–Sun week; for periods longer than a week (biweekly+) the
 * same {done, due} repeats across every week the running period spans, which
 * is exactly what `periodStatusFor` already says for a dateKey in that week —
 * not a second, competing definition of "due this week".
 */
function weekEntry(
  habit: Pick<HabitView, 'id' | 'schedule' | 'target'>,
  logs: HabitLogView[],
  weekMonday: string,
): WeekHistoryEntry {
  if (isDayBased(habit.schedule)) {
    return { done: doneCountInPeriod(logs, habit.id, weekRangeForDay(weekMonday)), due: 7 };
  }
  const status = periodStatusFor(habit, logs, weekMonday);
  return { done: status.count, due: status.target };
}

/**
 * 12 calendar weeks ending with the week containing `now`, oldest first — the
 * per-row bar series in habit-table.tsx (issue #905).
 */
export function historyWeeks(
  habit: Pick<HabitView, 'id' | 'schedule' | 'target'>,
  logs: HabitLogView[],
  now: Date = new Date(),
): WeekHistoryEntry[] {
  const currentMonday = weekRangeForDay(toDateKey(now)).start;
  return Array.from({ length: 12 }, (_, index) =>
    weekEntry(habit, logs, addDaysToKey(currentMonday, (index - 11) * 7)),
  );
}
