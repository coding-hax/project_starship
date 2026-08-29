'use client';

import { metEarlierInPeriod, toDateKey } from './due-today';
import { isDoneOnDay } from './schedule-rules';
import { computeStreak } from './streak';
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
 * The three stat tiles atop /routinen (issue #905) — HEUTE/DIESE WOCHE/
 * LÄNGSTE SERIE, replacing the standalone `StreakSummaryCard`. No
 * `useBlockReady`: /routinen has no `OverviewReadyProvider` (that hook is
 * inert outside one anyway), so the loading gate below is the only one that
 * matters, same `undefined` check `HabitList` already used.
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
  const longestStreak = Math.max(0, ...active.map((habit) => computeStreak(habit, logs, now)));

  return (
    <div className="habit-tiles">
      <Tile
        label="HEUTE"
        value={doneToday}
        denominator={`von ${dueToday.length}`}
        showBar
        barTotal={dueToday.length}
      />
      <Tile
        label="DIESE WOCHE"
        value={doneThisWeek}
        denominator={`von ${goalThisWeek}`}
        showBar
        barTotal={goalThisWeek}
      />
      <Tile label="LÄNGSTE SERIE" value={longestStreak} denominator="Tage" showBar={false} />
    </div>
  );
}
