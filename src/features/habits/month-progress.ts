import { addMonths, startOfMonth, toDateKey } from './due-today';
import { addDaysToKey, doneCountInPeriod, periodRangeFor } from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

export interface MonthProgress {
  done: number;
  due: number;
}

function isDayBased(schedule: HabitView['schedule']): boolean {
  return schedule === 'daily' || schedule === 'custom';
}

/**
 * Erledigt/fällig for `habit` in the calendar month `viewedMonth` anchors
 * (issue #905, the "N von M fälligen Tagen" line in the expanded row).
 * `daily`/`custom` count days in the month (`due` = the month's day count,
 * lifted from `monthEnd`'s own day-of-month digits rather than a second date
 * computation). Every other schedule counts periods, not days — "3× pro
 * Woche" isn't the day count, it's the Soll — so `due` sums `habit.target`
 * once per running period whose start falls in the month, and `done` sums
 * `doneCountInPeriod` over each of those full periods (a period starting late
 * in the month still counts whole, the same way `historyWeeks` attributes a
 * multi-week period to the week it's running in).
 */
export function monthProgress(
  habit: Pick<HabitView, 'id' | 'schedule' | 'target'>,
  logs: HabitLogView[],
  viewedMonth: Date,
): MonthProgress {
  const monthStart = toDateKey(startOfMonth(viewedMonth));
  const monthEnd = addDaysToKey(toDateKey(addMonths(viewedMonth, 1)), -1);

  if (isDayBased(habit.schedule)) {
    return {
      done: doneCountInPeriod(logs, habit.id, { start: monthStart, end: monthEnd }),
      due: Number(monthEnd.slice(-2)),
    };
  }

  const periodStarts = new Set<string>();
  for (let day = monthStart; day <= monthEnd; day = addDaysToKey(day, 1)) {
    const range = periodRangeFor(habit, day);
    if (range.start >= monthStart) periodStarts.add(range.start);
  }

  let done = 0;
  for (const start of periodStarts) {
    done += doneCountInPeriod(logs, habit.id, periodRangeFor(habit, start));
  }

  return { done, due: periodStarts.size * habit.target };
}
