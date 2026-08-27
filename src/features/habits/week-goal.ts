import { doneCountInPeriod, weekRangeForDay } from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

export interface WeekGoal {
  done: number;
  goal: number;
}

/** How many of `habit`'s occurrences count towards a Mon–Sun week (issue #863). */
function weeklyQuota(habit: Pick<HabitView, 'schedule' | 'target'>): number {
  if (habit.schedule === 'daily' || habit.schedule === 'custom') return 7;
  if (habit.schedule === 'weekly') return habit.target;
  return 0;
}

/**
 * "Diese Woche" ring (issue #863): Mon–Sun completions over Mon–Sun quota,
 * summed across every non-archived habit whose period is at most a week —
 * `biweekly`/`monthly`/… have no weekly quota and are left out entirely
 * rather than prorated, which would fake a precision that isn't there.
 * `done` is capped per habit at its own quota, so the sum never exceeds
 * `goal` and the ring's fraction stays inside [0, 1].
 */
export function weekGoal(
  habits: HabitView[],
  logs: HabitLogView[],
  dateKey: string,
): WeekGoal {
  const range = weekRangeForDay(dateKey);
  let done = 0;
  let goal = 0;

  for (const habit of habits) {
    if (habit.archivedAt !== null) continue;
    const quota = weeklyQuota(habit);
    if (quota === 0) continue;
    goal += quota;
    done += Math.min(doneCountInPeriod(logs, habit.id, range), quota);
  }

  return { done, goal };
}
