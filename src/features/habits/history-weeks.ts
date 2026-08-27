import { addDaysToKey, doneCountInPeriod, periodStatusFor, weekRangeForDay } from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

export interface WeekBar {
  ratio: number;
  isCurrent: boolean;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * The last `count` ISO weeks (Mon–Sun) ending with the week containing
 * `dateKey`, oldest first — the "12 Wochen" bar row (issue #863). `daily`/
 * `custom` and `weekly` compare that week's own completions against a
 * weekly target (7, or `habit.target`). Periods longer than a week
 * (`biweekly`/`monthly`/…) have no "due this week" of their own — every week
 * inside such a period gets the same containing-period ratio
 * (`periodStatusFor`) instead of an invented weekly cadence.
 */
export function historyWeeks(
  habit: Pick<HabitView, 'id' | 'schedule' | 'target'>,
  logs: HabitLogView[],
  dateKey: string,
  count = 12,
): WeekBar[] {
  const currentMonday = weekRangeForDay(dateKey).start;
  const isDayBased = habit.schedule === 'daily' || habit.schedule === 'custom';
  const isWeekly = habit.schedule === 'weekly';

  const bars: WeekBar[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const monday = addDaysToKey(currentMonday, -7 * i);
    let ratio: number;
    if (isDayBased) {
      ratio = clamp01(doneCountInPeriod(logs, habit.id, weekRangeForDay(monday)) / 7);
    } else if (isWeekly) {
      ratio = clamp01(doneCountInPeriod(logs, habit.id, weekRangeForDay(monday)) / habit.target);
    } else {
      const status = periodStatusFor(habit, logs, monday);
      ratio = clamp01(status.count / status.target);
    }
    bars.push({ ratio, isCurrent: i === 0 });
  }
  return bars;
}
