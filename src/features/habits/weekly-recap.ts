import { currentWeekRange, weekDays } from './due-today';
import { isDoneInWeek, isDoneOnDay, type WeekRange } from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

/**
 * "Wochenrückblick" (issue #431, M-2 of #416): purely-computed "N von M" for
 * the last fully completed Mon–Sun week, plus an optional superlative against
 * the habit's *own* history — never another person's (docs/VISION.md).
 */

export interface WeekQuote {
  met: number;
  total: number;
}

export type Superlative =
  | { kind: 'best-ever' }
  | { kind: 'best-since'; weeks: number }
  | { kind: 'tied-with-last-week' };

export interface WeeklyRecap {
  metric: WeekQuote;
  superlative: Superlative | null;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * A habit counts towards `week` if it existed by the week's end and had not
 * been archived by then. `createdAt`/`archivedAt` as they stand today are the
 * only "was this habit around back then" signal available without a new
 * field (AC8) — read as a snapshot at the end of `week`.
 */
function isActiveInWeek(
  habit: Pick<HabitView, 'createdAt' | 'archivedAt'>,
  week: WeekRange,
): boolean {
  if (habit.createdAt.slice(0, 10) > week.end) return false;
  if (habit.archivedAt !== null && habit.archivedAt.slice(0, 10) <= week.end) return false;
  return true;
}

/** "Soll erfüllt" for one habit in `week` (AC3): weekly = ≥ 1 done, daily/custom = every day done. */
function metQuotaInWeek(
  habit: Pick<HabitView, 'id' | 'schedule'>,
  logs: HabitLogView[],
  week: WeekRange,
  days: string[],
): boolean {
  if (habit.schedule === 'weekly') return isDoneInWeek(logs, habit.id, week);
  return days.every((day) => isDoneOnDay(logs, habit.id, day));
}

/** N von M (AC3) for the Mon–Sun week containing `anchor`. */
function computeWeekQuote(habits: HabitView[], logs: HabitLogView[], anchor: Date): WeekQuote {
  const week = currentWeekRange(anchor);
  const days = weekDays(anchor);
  const active = habits.filter((habit) => isActiveInWeek(habit, week));
  const met = active.filter((habit) => metQuotaInWeek(habit, logs, week, days)).length;
  return { met, total: active.length };
}

function ratio(quote: WeekQuote): number {
  return quote.total === 0 ? 0 : quote.met / quote.total;
}

/**
 * The superlative (AC4): compares the reference week's ratio against every
 * earlier week that actually had data (`total > 0`), most recent first —
 * `previousDataWeeks[0]`, if present, is literally last week.
 */
function computeSuperlative(
  reference: WeekQuote,
  previousDataWeeks: WeekQuote[],
): Superlative | null {
  if (previousDataWeeks.length === 0) return null; // AC5: zu wenig Historie

  const referenceRatio = ratio(reference);
  const beatsAll = previousDataWeeks.every((week) => referenceRatio > ratio(week));
  if (beatsAll) {
    return previousDataWeeks.length === 1
      ? { kind: 'best-ever' }
      : { kind: 'best-since', weeks: previousDataWeeks.length };
  }

  const lastWeek = previousDataWeeks[0];
  if (referenceRatio === ratio(lastWeek)) return { kind: 'tied-with-last-week' };

  return null;
}

/**
 * The full card payload, or `null` when the card should not render at all
 * (AC6: no active habits in the reference week).
 */
export function computeWeeklyRecap(
  habits: HabitView[],
  logs: HabitLogView[],
  now: Date = new Date(),
): WeeklyRecap | null {
  const referenceAnchor = addDays(now, -7); // AC2: the last fully completed week, never the running one
  const metric = computeWeekQuote(habits, logs, referenceAnchor);
  if (metric.total === 0) return null;

  const earliestCreatedAt = habits.reduce(
    (min, habit) => (habit.createdAt < min ? habit.createdAt : min),
    habits[0].createdAt,
  );

  const previousDataWeeks: WeekQuote[] = [];
  let cursor = addDays(referenceAnchor, -7);
  while (currentWeekRange(cursor).end >= earliestCreatedAt.slice(0, 10)) {
    const quote = computeWeekQuote(habits, logs, cursor);
    if (quote.total > 0) previousDataWeeks.push(quote);
    cursor = addDays(cursor, -7);
  }

  return { metric, superlative: computeSuperlative(metric, previousDataWeeks) };
}
