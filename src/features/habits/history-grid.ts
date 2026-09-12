import { toDateKey } from './due-today';
import { isDoneOnDay } from './schedule-rules';
import type { HabitLogView } from './use-habit-logs';
import { compareHabits } from './use-habits';
import type { HabitView } from './use-habits';

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Local calendar parse of a `YYYY-MM-DD` key — the inverse of `toDateKey`. */
function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export interface HistoryGridDay {
  dateKey: string;
  /** Ids of active habits done that day, bottom-of-stack first — `compareHabits`
   *  order (oldest `createdAt` first), so the first-created habit always anchors
   *  the column. */
  habitIds: string[];
}

export interface HistoryGrid {
  /** Oldest first, today last — spans `historyLeftEdge` … today (issue #1184),
   *  not a fixed count any more. */
  days: HistoryGridDay[];
  /** Sum of filled cells across every rendered day, not just the visible ones —
   *  see `visibleDoneCount` for the card head's value (issue #1184 AK5). */
  total: number;
}

/**
 * Earliest calendar day an active habit's own creation day or its oldest done
 * log reaches back to (issue #1184, AK3) — floored at `windowDays - 1` days
 * before `now` so a habit with no history older than the window still gets
 * the old fixed-size window (AK4). Archived habits and their logs never move
 * it (AK3). An epoch `createdAt` (missing field, `use-habits.ts`'s
 * `new Date(0)` fallback) reads as "unknown" rather than "56 years ago" — only
 * that habit's own logs, if any, can still move the edge.
 */
export function historyLeftEdge(
  habits: HabitView[],
  logs: HabitLogView[],
  now: Date = new Date(),
  windowDays = 30,
): string {
  const floorKey = toDateKey(addDays(now, -(windowDays - 1)));
  const active = habits.filter((habit) => habit.archivedAt === null);

  let earliest = floorKey;
  for (const habit of active) {
    const createdAt = new Date(habit.createdAt);
    if (createdAt.getTime() !== 0) {
      const createdKey = toDateKey(createdAt);
      if (createdKey < earliest) earliest = createdKey;
    }
    for (const log of logs) {
      if (log.habitId === habit.id && log.done && log.logDate < earliest) {
        earliest = log.logDate;
      }
    }
  }
  return earliest;
}

/**
 * 30-day grid data behind habit-history-card.tsx (issue #1070, replaces
 * history-days.ts + step-path.ts): which active habits were done on which day
 * between `historyLeftEdge` and today, in the order they stack in a column.
 * Archived habits are excluded entirely (issue #1070 AC7) — same rule
 * `countHabitsOnStreak` already applied to the card this one replaces. Issue
 * #1184 replaced the fixed 30-day span with a variable one reaching back to
 * `historyLeftEdge` — everything is rendered, there is no re-anchoring buffer
 * (the data is bounded on both ends, unlike `calendar-strip.tsx`'s open-ended
 * calendar).
 */
export function historyGrid(
  habits: HabitView[],
  logs: HabitLogView[],
  now: Date = new Date(),
  windowDays = 30,
): HistoryGrid {
  const active = habits.filter((habit) => habit.archivedAt === null).sort(compareHabits);
  const leftEdge = parseDateKey(historyLeftEdge(habits, logs, now, windowDays));
  const todayKey = toDateKey(now);
  const totalDays =
    Math.round((parseDateKey(todayKey).getTime() - leftEdge.getTime()) / 86_400_000) + 1;

  const days: HistoryGridDay[] = Array.from({ length: totalDays }, (_, index) => {
    const dateKey = toDateKey(addDays(leftEdge, index));
    const habitIds = active.filter((habit) => isDoneOnDay(logs, habit.id, dateKey)).map((habit) => habit.id);
    return { dateKey, habitIds };
  });

  const total = days.reduce((sum, day) => sum + day.habitIds.length, 0);

  return { days, total };
}

/**
 * Whether `habitId` was done on `day` — replaces `cellHabitId`'s stacking
 * lookup now that each habit gets its own fixed grid row instead of a
 * baseline stack (issue #1150).
 */
export function isHabitDoneOnDay(day: HistoryGridDay, habitId: string): boolean {
  return day.habitIds.includes(habitId);
}

/**
 * Sum of filled cells across the visible slice `[firstIndex, lastIndex]`
 * (inclusive) — the card head's value once the grid can scroll (issue #1184
 * AK5), replacing `HistoryGrid.total` there.
 */
export function visibleDoneCount(days: HistoryGridDay[], firstIndex: number, lastIndex: number): number {
  let sum = 0;
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    sum += days[index]?.habitIds.length ?? 0;
  }
  return sum;
}

const RELATIVE_LEFT_LABEL: Record<number, string> = {
  30: 'vor 30 Tagen',
  28: 'vor 4 Wochen',
  21: 'vor 3 Wochen',
  14: 'vor 2 Wochen',
  7: 'vor 1 Woche',
};

const RELATIVE_ARIA_SUFFIX: Record<number, string> = {
  30: 'in den letzten 30 Tagen',
  28: 'in den letzten 4 Wochen',
  21: 'in den letzten 3 Wochen',
  14: 'in den letzten 2 Wochen',
  7: 'in der letzten Woche',
};

const DAY_MONTH = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short' });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('de-DE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function formatDayLabel(dateKey: string, currentYear: number): string {
  const [year] = dateKey.split('-').map(Number);
  const date = parseDateKey(dateKey);
  return (year === currentYear ? DAY_MONTH : DAY_MONTH_YEAR).format(date);
}

export interface HistoryAxisInput {
  /** The configured window size — picks the relative-phrase branch's wording. */
  windowDays: number;
  days: HistoryGridDay[];
  firstIndex: number;
  lastIndex: number;
  /** Today's date key — the resting-state check is `days[lastIndex] === today`. */
  today: string;
  /** `visibleDoneCount` for the same slice — carried into the aria label. */
  doneCount: number;
}

export interface HistoryAxis {
  leftLabel: string;
  rightLabel: string;
  ariaLabel: string;
}

/**
 * Card-head axis labels and aria text (issue #1184 AK6/AK7) — relative
 * phrasing ("vor 30 Tagen" … "heute") while today is the last visible day,
 * else the visible slice's own date range in `Intl.DateTimeFormat('de-DE',
 * { day: 'numeric', month: 'short' })`, with a year suffix only outside the
 * current year.
 */
export function historyAxis({
  windowDays,
  days,
  firstIndex,
  lastIndex,
  today,
  doneCount,
}: HistoryAxisInput): HistoryAxis {
  const lastDay = days[lastIndex];
  if (lastDay.dateKey === today) {
    return {
      leftLabel: RELATIVE_LEFT_LABEL[windowDays],
      rightLabel: 'heute',
      ariaLabel: `${doneCount} Erledigungen ${RELATIVE_ARIA_SUFFIX[windowDays]}`,
    };
  }

  const currentYear = Number(today.slice(0, 4));
  const firstDay = days[firstIndex];
  const leftLabel = formatDayLabel(firstDay.dateKey, currentYear);
  const rightLabel = formatDayLabel(lastDay.dateKey, currentYear);
  return {
    leftLabel,
    rightLabel,
    ariaLabel: `${doneCount} Erledigungen vom ${leftLabel} bis ${rightLabel}`,
  };
}
