import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

/** Local calendar day as `YYYY-MM-DD` — matches `HabitLogData.logDate` (types.ts). */
export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Monday–Sunday range containing `date`, as date keys (ISO week, Monday = start). */
export function currentWeekRange(date: Date): { start: string; end: string } {
  const weekday = date.getDay(); // 0 = Sunday
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + diffToMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { start: toDateKey(monday), end: toDateKey(sunday) };
}

/**
 * Which habits belong in the Heute check-off list (issue #103). Daily habits are
 * always due — the point there is the check-off itself, not a filter. Weekly
 * habits drop out once done earlier in the current Mon–Sun week; a completion
 * *today* does not count against it, so the row that was just checked off stays
 * visible and tappable to undo (AC2). `schedule: 'custom'` has no due-logic yet
 * (schema.ts: reserved, no UI) — treated like daily so it is never silently hidden.
 */
export function isDueToday(
  habit: HabitView,
  logs: HabitLogView[],
  now: Date = new Date(),
): boolean {
  if (habit.schedule !== 'weekly') return true;

  const today = toDateKey(now);
  const { start, end } = currentWeekRange(now);

  return !logs.some(
    (log) =>
      log.habitId === habit.id &&
      log.done &&
      log.logDate !== today &&
      log.logDate >= start &&
      log.logDate <= end,
  );
}
