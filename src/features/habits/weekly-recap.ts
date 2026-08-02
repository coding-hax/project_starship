import { currentWeekRange, weekDays } from './due-today';
import { doneCountInPeriod, isDoneOnDay, type WeekRange } from './schedule-rules';
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

/**
 * Whether `habit`'s cadence fits a single Mon–Sun week at all (issue #509): a
 * fortnight/month/quarter/year has no weekly quota to report, so it is
 * excluded from both the numerator and denominator, not counted as "missed".
 */
function fitsInAWeek(habit: Pick<HabitView, 'schedule'>): boolean {
  return habit.schedule === 'daily' || habit.schedule === 'weekly' || habit.schedule === 'custom';
}

/** "Soll erfüllt" for one habit in `week` (AC3): weekly = `target` reached, daily/custom = every day done. */
function metQuotaInWeek(
  habit: Pick<HabitView, 'id' | 'schedule' | 'target'>,
  logs: HabitLogView[],
  week: WeekRange,
  days: string[],
): boolean {
  if (habit.schedule === 'weekly') return doneCountInPeriod(logs, habit.id, week) >= habit.target;
  return days.every((day) => isDoneOnDay(logs, habit.id, day));
}

/** N von M (AC3) for the Mon–Sun week containing `anchor`. */
function computeWeekQuote(habits: HabitView[], logs: HabitLogView[], anchor: Date): WeekQuote {
  const week = currentWeekRange(anchor);
  const days = weekDays(anchor);
  const active = habits.filter((habit) => fitsInAWeek(habit) && isActiveInWeek(habit, week));
  const met = active.filter((habit) => metQuotaInWeek(habit, logs, week, days)).length;
  return { met, total: active.length };
}

function ratio(quote: WeekQuote): number {
  return quote.total === 0 ? 0 : quote.met / quote.total;
}

/** One earlier week with data, at `distance` calendar weeks before the reference week. */
interface PreviousWeek {
  distance: number;
  ratio: number;
}

const MIN_HISTORY_FOR_BEST_EVER = 3; // #504: "Deine beste Woche" braucht eine Mindesthistorie, sonst ist der Satz zu groß

/**
 * The superlative (#504): compares the reference week's ratio against every
 * earlier week that actually had data, most recent first —
 * `history[0]`, if present, is the calendar-nearest data week.
 *
 * - `best-ever`: strictly beats every earlier data week, and there are at
 *   least `MIN_HISTORY_FOR_BEST_EVER` of them.
 * - `best-since`: an earlier week was strictly better; `weeks` is the
 *   calendar distance to the most recent such week (>= 2 — a strictly
 *   better *direct* previous week (distance 1) is not a "best since", it's
 *   just "last week was better", so it returns `null` instead).
 * - `tied-with-last-week`: the direct previous week (distance 1, with data)
 *   has the same ratio. Checked before the `best-since` search, so a tie
 *   with the direct previous week wins over a better week further back.
 */
function computeSuperlative(reference: WeekQuote, history: PreviousWeek[]): Superlative | null {
  if (history.length === 0) return null; // keine Vorwoche mit Daten

  const referenceRatio = ratio(reference);

  const directPrev = history[0].distance === 1 ? history[0] : null;
  if (directPrev) {
    if (directPrev.ratio > referenceRatio) return null;
    if (directPrev.ratio === referenceRatio) return { kind: 'tied-with-last-week' };
  }

  const better = history.find((week) => week.ratio > referenceRatio);
  if (better) return { kind: 'best-since', weeks: better.distance };

  const beatsAll = history.every((week) => referenceRatio > week.ratio);
  if (beatsAll && history.length >= MIN_HISTORY_FOR_BEST_EVER) return { kind: 'best-ever' };

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

  const history: PreviousWeek[] = [];
  let cursor = addDays(referenceAnchor, -7);
  let distance = 1;
  while (currentWeekRange(cursor).end >= earliestCreatedAt.slice(0, 10)) {
    const quote = computeWeekQuote(habits, logs, cursor);
    if (quote.total > 0) history.push({ distance, ratio: ratio(quote) });
    cursor = addDays(cursor, -7);
    distance += 1;
  }

  return { metric, superlative: computeSuperlative(metric, history) };
}
