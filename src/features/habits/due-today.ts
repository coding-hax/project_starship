import { isDoneOnDay, isTargetMet, periodRangeFor } from './schedule-rules';
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

/** One grid cell: a date key plus whether it falls in the viewed month (issue #487). */
export interface MonthGridDay {
  dateKey: string;
  inMonth: boolean;
}

/**
 * Mon–Sun grid cells for the month containing `date`. Leading/trailing weeks
 * are filled with the real days of the neighbouring months (issue #487,
 * replaces the `null`-padding from #124 AC1) so every row stays a full
 * Mon–Sun week and is fully tappable. Length is always a multiple of 7.
 */
export function monthDays(date: Date): MonthGridDay[] {
  const year = date.getFullYear();
  const month = date.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay(); // 0 = Sunday
  const leadingCount = firstWeekday === 0 ? 6 : firstWeekday - 1;

  const days: MonthGridDay[] = [];
  // `new Date(year, month, 1 - i)` rolls back into the previous month for
  // i >= 1 — no separate "previous month" calculation needed.
  for (let i = leadingCount; i > 0; i -= 1) {
    days.push({ dateKey: toDateKey(new Date(year, month, 1 - i)), inMonth: false });
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    days.push({ dateKey: toDateKey(new Date(year, month, day)), inMonth: true });
  }
  const trailingCount = (7 - (days.length % 7)) % 7;
  for (let day = 1; day <= trailingCount; day += 1) {
    days.push({ dateKey: toDateKey(new Date(year, month + 1, day)), inMonth: false });
  }

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

export interface DueToday {
  done: number;
  due: number;
}

/**
 * "heute N von M" für Routinen allein (issue #863) — die einzige Stelle, die
 * "heute fällig"/"heute erledigt" für Routinen entscheidet; sowohl
 * `computeDailyProgress` (daily-progress.ts, modulübergreifend mit Aufgaben)
 * als auch der Statusblock-Ring auf /routinen rufen sie auf, statt die Regel
 * zweimal zu bauen (AK5). Archivierte Routinen zählen nie mit; eine Routine,
 * deren `target` an einem früheren Tag ihrer laufenden Periode schon erreicht
 * wurde, fällt ganz aus Zähler und Nenner heraus (issue #503, #509), damit
 * eine heute abgehakte Routine im Ring stehen bleibt statt rückwärts zu
 * springen.
 */
export function habitsDueToday(
  habits: HabitView[],
  logs: HabitLogView[],
  now: Date = new Date(),
): DueToday {
  const dateKey = toDateKey(now);
  const dueHabits = habits.filter(
    (habit) => habit.archivedAt === null && !metEarlierInPeriod(habit, logs, now),
  );
  return {
    due: dueHabits.length,
    done: dueHabits.filter((habit) => isDoneOnDay(logs, habit.id, dateKey)).length,
  };
}

/**
 * Whether `habit`'s `target` was already reached on an earlier day of its
 * running period (issue #509, generalizes issue #224's weekly-only rule) —
 * drives the "Diese Woche schon erledigt" hint in the Übersicht check-off list
 * and its progress-ring exclusion. A completion *today* does not count towards
 * this, so the hint stays even after today's own row is checked off (issue
 * #288) — it reports on the period, not on today's checkbox. `daily`/`custom`
 * (target always 1, one-day period) can never be "earlier" than themselves.
 */
export function metEarlierInPeriod(
  habit: Pick<HabitView, 'id' | 'schedule' | 'target'>,
  logs: HabitLogView[],
  now: Date = new Date(),
): boolean {
  const today = toDateKey(now);
  const range = periodRangeFor(habit, today);
  const earlierLogs = logs.filter((log) => log.logDate !== today);

  return isTargetMet(habit, earlierLogs, range);
}
