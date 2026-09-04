import { toDateKey } from './due-today';
import { isDoneOnDay } from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';
import { compareHabits } from './use-habits';
import type { HabitView } from './use-habits';

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export interface HistoryGridDay {
  dateKey: string;
  /** Ids of active habits done that day, bottom-of-stack first — `compareHabits`
   *  order (oldest `createdAt` first), so the first-created habit always anchors
   *  the column. */
  habitIds: string[];
}

export interface HistoryGrid {
  /** 30 entries, oldest first, today last. */
  days: HistoryGridDay[];
  /** Sum of filled cells across the whole window — the card head's value. */
  total: number;
}

/**
 * 30-day grid data behind habit-history-card.tsx (issue #1070, replaces
 * history-days.ts + step-path.ts): which active habits were done on which of
 * the last 30 days, in the order they stack in a column. Archived habits are
 * excluded entirely (issue #1070 AC7) — same rule `countHabitsOnStreak`
 * already applied to the card this one replaces.
 */
export function historyGrid(habits: HabitView[], logs: HabitLogView[], now: Date = new Date()): HistoryGrid {
  const active = habits.filter((habit) => habit.archivedAt === null).sort(compareHabits);

  const days: HistoryGridDay[] = Array.from({ length: 30 }, (_, index) => {
    const dateKey = toDateKey(addDays(now, index - 29));
    const habitIds = active.filter((habit) => isDoneOnDay(logs, habit.id, dateKey)).map((habit) => habit.id);
    return { dateKey, habitIds };
  });

  const total = days.reduce((sum, day) => sum + day.habitIds.length, 0);

  return { days, total };
}

/**
 * The habit id filling one grid cell, or `null` for an empty cell — `rowIndex`
 * counts from the top (0) down to `rowCount - 1` at the baseline, matching how
 * the card renders rows top to bottom. Cells fill from the baseline up with no
 * gaps (issue #1070 AC3): the bottom `day.habitIds.length` rows are filled, in
 * stack order, everything above is empty.
 */
export function cellHabitId(day: HistoryGridDay, rowIndex: number, rowCount: number): string | null {
  const positionFromBottom = rowCount - 1 - rowIndex;
  return positionFromBottom >= 0 && positionFromBottom < day.habitIds.length
    ? day.habitIds[positionFromBottom]
    : null;
}
