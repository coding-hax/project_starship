import { toDateKey } from './due-today';
import { isDoneOnDay, isFrozenOnDay } from './schedule-rules';
import { computeStreak } from './streak';
import type { HabitFreezeView } from './use-habit-freezes';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

/**
 * The streak joker (issue #433, M-3 of #416): manually spent to bridge one
 * missed due day instead of breaking the streak. Owner decision (31.07.26):
 * quota per habit, 2 per calendar month, `daily`/`custom` only — `weekly`
 * stays untouched.
 */
export const MAX_JOKERS_PER_MONTH = 2;

/** The one day a joker can ever bridge: always exactly yesterday relative to `now`. */
export function gapDay(now: Date): string {
  return toDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
}

/** `YYYY-MM` from a `YYYY-MM-DD` date key — the calendar month a freeze counts against. */
export function monthKey(dateKey: string): string {
  return dateKey.slice(0, 7);
}

function freezesInMonth(freezes: HabitFreezeView[], habitId: string, month: string): number {
  return freezes.filter(
    (freeze) => freeze.habitId === habitId && monthKey(freeze.freezeDate) === month,
  ).length;
}

/** How many jokers `habitId` has left in `month` (`YYYY-MM`), never negative. */
export function remainingJokers(freezes: HabitFreezeView[], habitId: string, month: string): number {
  return Math.max(0, MAX_JOKERS_PER_MONTH - freezesInMonth(freezes, habitId, month));
}

/**
 * Whether `habit` can spend a joker right now. True exactly when: the schedule
 * is `daily`/`custom` (never `weekly`), yesterday (`gapDay`) is a genuine gap
 * (no `done` log, not already frozen), the habit still has quota left this
 * month, and freezing that gap would actually reconnect a streak of at least 2
 * — a joker bridges an existing streak, it never invents one out of a single
 * isolated gap.
 */
export function canRescue(
  habit: Pick<HabitView, 'id' | 'schedule'>,
  logs: HabitLogView[],
  freezes: HabitFreezeView[],
  now: Date = new Date(),
): boolean {
  if (habit.schedule === 'weekly') return false;

  const gap = gapDay(now);
  if (isDoneOnDay(logs, habit.id, gap)) return false;
  if (isFrozenOnDay(freezes, habit.id, gap)) return false;
  if (remainingJokers(freezes, habit.id, monthKey(gap)) < 1) return false;

  const hypothetical = [...freezes, { id: '', habitId: habit.id, freezeDate: gap }];
  return computeStreak(habit, logs, hypothetical, now) >= 2;
}

/**
 * Whether the streak currently shown for `habit` (the same run `computeStreak`
 * counts) contains at least one frozen day — drives the ❄️ marker (issue #433
 * point 3), a `weekly` habit never qualifies.
 */
export function currentStreakUsesFreeze(
  habit: Pick<HabitView, 'id' | 'schedule'>,
  logs: HabitLogView[],
  freezes: HabitFreezeView[],
  now: Date = new Date(),
): boolean {
  if (habit.schedule === 'weekly') return false;

  let cursor = now;
  const today = toDateKey(now);
  if (!isDoneOnDay(logs, habit.id, today) && !isFrozenOnDay(freezes, habit.id, today)) {
    cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  }

  let usedFreeze = false;
  let dateKey = toDateKey(cursor);
  while (isDoneOnDay(logs, habit.id, dateKey) || isFrozenOnDay(freezes, habit.id, dateKey)) {
    if (!isDoneOnDay(logs, habit.id, dateKey)) usedFreeze = true;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() - 1);
    dateKey = toDateKey(cursor);
  }
  return usedFreeze;
}
