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
 * Whether `habitId` was done on `day` — replaces `cellHabitId`'s stacking
 * lookup now that each habit gets its own fixed grid row instead of a
 * baseline stack (issue #1150).
 */
export function isHabitDoneOnDay(day: HistoryGridDay, habitId: string): boolean {
  return day.habitIds.includes(habitId);
}
