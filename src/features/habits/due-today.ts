import { isDoneInWeek } from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

/** Local calendar day as `YYYY-MM-DD` — matches `HabitLogData.logDate` (types.ts). */
export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const MONTH_NAMES = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
];

/** The first of `date`'s month, local calendar (issue #124). */
export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/** `date`'s month shifted by `delta` months, always normalized to the 1st. */
export function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

/** `"Juli 2026"` — the month bar heading (issue #124). */
export function monthLabel(date: Date): string {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

/** `"15. Juli 2026"` from a `YYYY-MM-DD` date key, for a cell's accessible name. */
export function dayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return `${day}. ${MONTH_NAMES[month - 1]} ${year}`;
}

/**
 * Mon–Sun grid cells for the month containing `date`, as date keys — `null`
 * pads the leading/trailing weeks so every row stays a full Mon–Sun week
 * (issue #124 AC1). Length is always a multiple of 7.
 */
export function monthDays(date: Date): Array<string | null> {
  const year = date.getFullYear();
  const month = date.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay(); // 0 = Sunday
  const leadingBlanks = firstWeekday === 0 ? 6 : firstWeekday - 1;

  const days: Array<string | null> = Array.from({ length: leadingBlanks }, () => null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    days.push(toDateKey(new Date(year, month, day)));
  }
  const trailingBlanks = (7 - (days.length % 7)) % 7;
  for (let i = 0; i < trailingBlanks; i += 1) days.push(null);

  return days;
}

/** Monday–Sunday range containing `date`, as date keys (ISO week, Monday = start). */
export function currentWeekRange(date: Date): { start: string; end: string } {
  const weekday = date.getDay(); // 0 = Sunday
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + diffToMonday);
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return { start: toDateKey(monday), end: toDateKey(sunday) };
}

/** The 7 date keys of the Mon–Sun week containing `date`, Monday first (issue #105). */
export function weekDays(date: Date): string[] {
  const weekday = date.getDay(); // 0 = Sunday
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() + diffToMonday);
  return Array.from({ length: 7 }, (_, offset) =>
    toDateKey(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + offset)),
  );
}

/**
 * Whether `habit` was already checked off on an earlier day of the current
 * Mon–Sun week (issue #224) — drives the "Diese Woche schon erledigt" hint in
 * the Übersicht check-off list. Only weekly habits can be done "earlier this
 * week" in a way that matters; a completion *today* does not count towards
 * this, so the hint stays even after today's own row is checked off
 * (issue #288) — it reports on the week, not on today's checkbox.
 */
export function doneEarlierThisWeek(
  habit: HabitView,
  logs: HabitLogView[],
  now: Date = new Date(),
): boolean {
  if (habit.schedule !== 'weekly') return false;

  const today = toDateKey(now);
  const range = currentWeekRange(now);
  const earlierLogs = logs.filter((log) => log.logDate !== today);

  return isDoneInWeek(earlierLogs, habit.id, range);
}
