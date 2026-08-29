import { countHabitsOnStreak } from './streak';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * 30 daily values ending with `now`, oldest first — the area-chart series in
 * habit-history-card.tsx (issue #905). Same rule as the current-day count
 * already used on /routinen (`countHabitsOnStreak`, streak.ts), called once
 * per day rather than rewritten: it already takes a stichtag (`now`).
 */
export function historyDays(
  habits: HabitView[],
  logs: HabitLogView[],
  now: Date = new Date(),
): number[] {
  return Array.from({ length: 30 }, (_, index) => countHabitsOnStreak(habits, logs, addDays(now, index - 29)));
}
