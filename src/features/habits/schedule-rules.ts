import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

/**
 * Shared "what counts as due/done" rules for habits (issue #243) — pure functions
 * over calendar-day *keys* (`YYYY-MM-DD`), never `Date` methods with an implied
 * timezone. `due-today.ts` and `streak.ts` (client, browser-local `Date`) and
 * `src/push/reminders/habits-open.ts` (server, Berlin `Date` via `berlinNow()`)
 * both feed this module a dateKey they derived themselves, so there is exactly
 * one place that decides "due"/"done" — not two truths that drift apart.
 */

export interface WeekRange {
  start: string;
  end: string;
}

function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Monday–Sunday range containing `dateKey` (ISO week, Monday = start) — the
 * dateKey-native counterpart to `currentWeekRange` (due-today.ts), for callers
 * that only have a calendar-day string, no browser `Date` (issue #243).
 */
export function weekRangeForDay(dateKey: string): WeekRange {
  const date = parseDateKey(dateKey);
  const weekday = date.getDay(); // 0 = Sunday
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + diffToMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { start: formatDateKey(monday), end: formatDateKey(sunday) };
}

/**
 * Whether `habit`'s schedule needs attention on `dateKey` at all. Daily and
 * custom are due every day (`custom` has no per-weekday rules yet — reserved,
 * see schema.ts); weekly is due on any day inside its own `weekRange`.
 */
export function isDueOnDay(
  habit: Pick<HabitView, 'schedule'>,
  dateKey: string,
  weekRange: WeekRange,
): boolean {
  if (habit.schedule !== 'weekly') return true;
  return dateKey >= weekRange.start && dateKey <= weekRange.end;
}

/** Whether `habitId` has a `done` log for the exact calendar day `dateKey`. */
export function isDoneOnDay(logs: HabitLogView[], habitId: string, dateKey: string): boolean {
  return logs.some((log) => log.habitId === habitId && log.logDate === dateKey && log.done);
}

/** Whether `habitId` has any `done` log inside `range` (inclusive on both ends). */
export function isDoneInWeek(logs: HabitLogView[], habitId: string, range: WeekRange): boolean {
  return logs.some(
    (log) =>
      log.habitId === habitId &&
      log.done &&
      log.logDate >= range.start &&
      log.logDate <= range.end,
  );
}
