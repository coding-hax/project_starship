'use client';

import { metEarlierInPeriod, toDateKey } from './due-today';
import { isDoneOnDay } from './schedule-rules';
import { countHabitsOnStreak } from './streak';
import { useHabitLogs } from './use-habit-logs';
import { useHabits } from './use-habits';
import { weekDone, weekGoal } from './week-goal';

function barWidth(done: number, total: number): string {
  return `${total > 0 ? Math.min(1, done / total) * 100 : 0}%`;
}

interface TileProps {
  label: string;
  value: number;
  denominator: string;
  showBar: boolean;
  barTotal?: number;
}

function Tile({ label, value, denominator, showBar, barTotal }: TileProps) {
  return (
    <div className="habit-tiles__tile">
      <dl className="habit-tiles__stat">
        <dt className="habit-tiles__label">{label}</dt>
        <dd className="habit-tiles__value-row">
          <span className="habit-tiles__value">{value}</span>
          <span className="habit-tiles__denominator">{denominator}</span>
        </dd>
      </dl>
      {showBar && (
        <div className="habit-tiles__bar" aria-hidden="true">
          <div className="habit-tiles__bar-fill" style={{ width: barWidth(value, barTotal ?? 0) }} />
        </div>
      )}
    </div>
  );
}

/**
 * The three stat tiles atop /routinen (issue #905) — Heute/Woche/Serie,
 * replacing the standalone `StreakSummaryCard`. The third tile counts active
 * habits with a running streak of at least two periods, not the longest
 * streak in days (issue #1005). No `useBlockReady`: /routinen has no
 * `OverviewReadyProvider` (that hook is inert outside one anyway), so the
 * loading gate below is the only one that matters, same `undefined` check
 * `HabitList` already used.
 */
export function HabitTiles() {
  const habits = useHabits();
  const logs = useHabitLogs();

  if (habits === undefined || logs === undefined) return null;

  const active = habits.filter((habit) => habit.archivedAt === null);
  if (active.length === 0) return null;

  const now = new Date();
  const today = toDateKey(now);
  const dueToday = active.filter((habit) => !metEarlierInPeriod(habit, logs, now));
  const doneToday = dueToday.filter((habit) => isDoneOnDay(logs, habit.id, today)).length;
  const goalThisWeek = weekGoal(active);
  const doneThisWeek = weekDone(active, logs, now);
  const onStreak = countHabitsOnStreak(active, logs, now, 2);

  return (
    <div className="habit-tiles">
      <Tile
        label="Heute"
        value={doneToday}
        denominator={`von ${dueToday.length}`}
        showBar
        barTotal={dueToday.length}
      />
      <Tile
        label="Woche"
        value={doneThisWeek}
        denominator={`von ${goalThisWeek}`}
        showBar
        barTotal={goalThisWeek}
      />
      <Tile label="Serie" value={onStreak} denominator={`von ${active.length}`} showBar={false} />
    </div>
  );
}
