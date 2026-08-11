import { and, isNull } from 'drizzle-orm';
import { db } from '@/db';
import {
  habitFreezes,
  habitLogs,
  habits,
  type Habit,
  type HabitFreeze,
  type HabitLog,
} from '@/db/schema';
import { addDaysToKey, isTargetMet, periodRangeFor, type WeekRange } from '@/features/habits/schedule-rules';
import { computeStreak } from '@/features/habits/streak';
import { berlinNow } from '@/push/schedule';
import type { PushPayload } from '@/push/send';
import type { ReminderKind } from './index';

/**
 * `computeStreak` (src/features/habits/streak.ts) reads a `Date` only through
 * its own local getters (never a UTC/ISO conversion) — feeding it a `Date`
 * built from the exact same Y-M-D components it will read back makes those
 * getters echo the Berlin dateKey regardless of the server process's own
 * timezone, so the client's streak algorithm can be reused unchanged here.
 */
function dateKeyAsLocalDate(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

interface OpenHabit {
  name: string;
  streak: number;
}

function streakSuffix(streak: number): string {
  return streak >= 2 ? ` — ${streak} Tage in Folge` : '';
}

function buildBody(open: OpenHabit[]): string {
  if (open.length === 1) return `${open[0].name}${streakSuffix(open[0].streak)}`;
  const shown = open.slice(0, 2).map((habit) => habit.name);
  const remaining = open.length - shown.length;
  return remaining > 0 ? `${shown.join(', ')} und ${remaining} weitere` : shown.join(', ');
}

/**
 * Owner-Entscheidung 2 (issue #509): the 20:00 reminder only mentions a habit
 * once its period is actually running out, not every evening for months —
 * `daily`/`custom` every day (as before), `weekly`/`biweekly` on the last day
 * of the period, `monthly` in its last 3 days, `quarterly`/`yearly` in their
 * last 7 days.
 */
function isInReminderWindow(habit: Pick<Habit, 'schedule'>, dateKey: string, range: WeekRange): boolean {
  switch (habit.schedule) {
    case 'daily':
    case 'custom':
      return true;
    case 'weekly':
    case 'biweekly':
      return dateKey === range.end;
    case 'monthly':
      return dateKey >= addDaysToKey(range.end, -2);
    case 'quarterly':
    case 'yearly':
      return dateKey >= addDaysToKey(range.end, -6);
    default:
      return true;
  }
}

/**
 * Pure so "which habits are open" is Vitest-testable without a database — same
 * belt-and-braces split as `selectDueTasks` (tasks-due.ts): the query below
 * already excludes archived/deleted habits, this is the belt to its braces.
 */
export function selectOpenHabits(
  candidates: Habit[],
  logs: HabitLog[],
  freezes: HabitFreeze[],
  dateKey: string,
): OpenHabit[] {
  return candidates
    .filter((habit) => habit.archivedAt === null && habit.deletedAt === null)
    .filter((habit) => {
      const range = periodRangeFor(habit, dateKey);
      if (!isInReminderWindow(habit, dateKey, range)) return false;
      return !isTargetMet(habit, logs, range);
    })
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .map((habit) => ({
      name: habit.name,
      streak: computeStreak(habit, logs, freezes, dateKeyAsLocalDate(dateKey)),
    }));
}

export async function build(now: Date): Promise<PushPayload | null> {
  const activeHabits = await db
    .select()
    .from(habits)
    .where(and(isNull(habits.archivedAt), isNull(habits.deletedAt)));

  if (activeHabits.length === 0) return null;

  const logs = await db.select().from(habitLogs).where(isNull(habitLogs.deletedAt));
  const freezes = await db.select().from(habitFreezes).where(isNull(habitFreezes.deletedAt));

  const { dateKey } = berlinNow(now);
  const open = selectOpenHabits(activeHabits, logs, freezes, dateKey);
  if (open.length === 0) return null;

  const title = open.length === 1 ? 'Noch offen' : `${open.length} Gewohnheiten heute noch offen`;
  return { title, body: buildBody(open), url: '/routinen' };
}

export const habitsOpen: ReminderKind = { kind: 'habits-open', times: ['20:00'], build };
