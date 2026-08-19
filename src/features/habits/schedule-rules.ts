import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

/**
 * Shared "what counts as due/done" rules for habits (issue #243) — pure functions
 * over calendar-day *keys* (`YYYY-MM-DD`), never `Date` methods with an implied
 * timezone. `due-today.ts` and `streak.ts` (client, browser-local `Date`) and
 * `src/push/reminders/habits-open.ts` (server, Berlin `Date` via `berlinNow()`)
 * both feed this module a dateKey they derived themselves, so there is exactly
 * one place that decides "due"/"done" — not two truths that drift apart.
 *
 * Issue #509 generalizes this from a hardcoded daily/weekly split to a "period
 * + target" model: `periodRangeFor` finds the running period for any schedule,
 * `isTargetMet` decides whether it's satisfied. Callers never ask
 * `schedule === 'weekly'` themselves anymore — that question has exactly one
 * answer, here.
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

/** `dateKey` shifted by `delta` calendar days (negative = earlier). */
export function addDaysToKey(dateKey: string, delta: number): string {
  const date = parseDateKey(dateKey);
  return formatDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta));
}

/** The calendar day immediately before `dateKey`. */
export function dayBefore(dateKey: string): string {
  return addDaysToKey(dateKey, -1);
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

export interface IsoWeek {
  /** The ISO week-year — the Thursday of the week decides it, not the Monday. */
  year: number;
  week: number;
}

/**
 * ISO-8601 week number + week-year for `dateKey` (no package — Owner-Entsch. 3
 * on issue #509 requires "alle zwei Wochen" to hang off the calendar week, not
 * an anchor field). Standard "nearest Thursday" algorithm: the ISO week-year is
 * whichever year owns that week's Thursday, and week 1 is the week containing
 * that year's first Thursday (equivalently: the week containing 4 January).
 */
export function isoWeek(dateKey: string): IsoWeek {
  const monday = parseDateKey(weekRangeForDay(dateKey).start);
  const thursday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3);
  const year = thursday.getFullYear();
  const week1Monday = parseDateKey(weekRangeForDay(`${year}-01-04`).start);
  const diffDays = Math.round((monday.getTime() - week1Monday.getTime()) / (24 * 60 * 60 * 1000));
  return { year, week: Math.floor(diffDays / 7) + 1 };
}

/** The last ISO week number of `year` — always the week containing 28 December. */
function lastIsoWeekOfYear(year: number): number {
  return isoWeek(`${year}-12-28`).week;
}

/**
 * Mon–Sun fortnight containing `dateKey`, paired by ISO calendar week (Owner-
 * Entsch. 3): odd weeks pair forward with the next (even) week, even weeks pair
 * backward with the previous (odd) week. An odd week that is also the last ISO
 * week of its year (the KW53→KW1 rollover) has no next week to pair with and
 * stands alone — deterministic, no cross-year state needed.
 */
function biweeklyRangeFor(dateKey: string): WeekRange {
  const week = weekRangeForDay(dateKey);
  const { year, week: weekNumber } = isoWeek(dateKey);
  const isOdd = weekNumber % 2 === 1;

  if (isOdd && weekNumber === lastIsoWeekOfYear(year)) {
    return week;
  }
  if (isOdd) {
    return { start: week.start, end: addDaysToKey(week.end, 7) };
  }
  return { start: addDaysToKey(week.start, -7), end: week.end };
}

/** The first–last day of the month containing `dateKey`. */
function monthRangeFor(dateKey: string): WeekRange {
  const date = parseDateKey(dateKey);
  const start = new Date(date.getFullYear(), date.getMonth(), 1);
  const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return { start: formatDateKey(start), end: formatDateKey(end) };
}

/** The Jan–Mar/Apr–Jun/Jul–Sep/Oct–Dec quarter containing `dateKey`. */
function quarterRangeFor(dateKey: string): WeekRange {
  const date = parseDateKey(dateKey);
  const quarterStartMonth = Math.floor(date.getMonth() / 3) * 3;
  const start = new Date(date.getFullYear(), quarterStartMonth, 1);
  const end = new Date(date.getFullYear(), quarterStartMonth + 3, 0);
  return { start: formatDateKey(start), end: formatDateKey(end) };
}

/** 1 January–31 December of `dateKey`'s year. */
function yearRangeFor(dateKey: string): WeekRange {
  const date = parseDateKey(dateKey);
  return {
    start: formatDateKey(new Date(date.getFullYear(), 0, 1)),
    end: formatDateKey(new Date(date.getFullYear(), 11, 31)),
  };
}

/**
 * The running period for `habit` containing `dateKey` — the single place that
 * decides what "this week" / "this month" / … means for a schedule. `daily`
 * and `custom` (no per-weekday rules yet, see schema.ts) are each their own
 * one-day period.
 */
export function periodRangeFor(habit: Pick<HabitView, 'schedule'>, dateKey: string): WeekRange {
  switch (habit.schedule) {
    case 'weekly':
      return weekRangeForDay(dateKey);
    case 'biweekly':
      return biweeklyRangeFor(dateKey);
    case 'monthly':
      return monthRangeFor(dateKey);
    case 'quarterly':
      return quarterRangeFor(dateKey);
    case 'yearly':
      return yearRangeFor(dateKey);
    default:
      return { start: dateKey, end: dateKey };
  }
}

/** Whether `habitId` has a `done` log for the exact calendar day `dateKey`. */
export function isDoneOnDay(logs: HabitLogView[], habitId: string, dateKey: string): boolean {
  return logs.some((log) => log.habitId === habitId && log.logDate === dateKey && log.done);
}

/** How many `done` logs `habitId` has inside `range` (inclusive on both ends). */
export function doneCountInPeriod(logs: HabitLogView[], habitId: string, range: WeekRange): number {
  return logs.filter(
    (log) =>
      log.habitId === habitId &&
      log.done &&
      log.logDate >= range.start &&
      log.logDate <= range.end,
  ).length;
}

/** Whether `habit`'s `target` is reached inside `range` — the general case of `isDoneInWeek`. */
export function isTargetMet(
  habit: Pick<HabitView, 'id' | 'target'>,
  logs: HabitLogView[],
  range: WeekRange,
): boolean {
  return doneCountInPeriod(logs, habit.id, range) >= habit.target;
}

export interface PeriodStatus {
  count: number;
  target: number;
  met: boolean;
}

/** "N von M" for `habit`'s running period around `dateKey` (issue #509 AC2/AC3). */
export function periodStatusFor(
  habit: Pick<HabitView, 'id' | 'schedule' | 'target'>,
  logs: HabitLogView[],
  dateKey: string,
): PeriodStatus {
  const range = periodRangeFor(habit, dateKey);
  const count = doneCountInPeriod(logs, habit.id, range);
  return { count, target: habit.target, met: count >= habit.target };
}
