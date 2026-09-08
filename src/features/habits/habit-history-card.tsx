'use client';

import { isHabitDoneOnDay, historyGrid, type HistoryGridDay } from './history-grid';
import { useHabitLogs } from './use-habit-logs';
import { compareHabits, useHabits } from './use-habits';

/** True when `dateKey` (`YYYY-MM-DD`) falls on a Monday, parsed as a local date to avoid UTC off-by-one. */
function isMonday(dateKey: string): boolean {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day).getDay() === 1;
}

/**
 * Grid column tracks for the 30 day cells plus a 2px track before every Monday
 * in the window (except the first day, even if it is itself a Monday — a gap
 * before the first column would just be dead space). `dayColumns[i]` and
 * `weekLineColumns[i]` are 1-based CSS grid line numbers.
 */
function weekLayout(days: HistoryGridDay[]): {
  gridTemplateColumns: string;
  dayColumns: number[];
  weekLineColumns: number[];
} {
  const tracks: string[] = [];
  const dayColumns: number[] = [];
  const weekLineColumns: number[] = [];

  days.forEach((day, index) => {
    if (index > 0 && isMonday(day.dateKey)) {
      tracks.push('2px');
      weekLineColumns.push(tracks.length);
    }
    tracks.push('minmax(0, 14px)');
    dayColumns.push(tracks.length);
  });

  return { gridTemplateColumns: tracks.join(' '), dayColumns, weekLineColumns };
}

/**
 * "Erledigt · 30 Tage" as a squares grid (issue #1070, replaces the step-chart
 * card from #905/#1040) — 30 columns of days, one fixed row per active habit
 * in `compareHabits` order (oldest on top, same order as the table above), a
 * done habit's emoji on a transparent cell, or a flat `--area-habits` fill
 * for a habit with no emoji (issue #1150, replaces the baseline-stacked,
 * emoji-less grid from #1070/#1101 — 30 fixed rows read "which" habit, not
 * just "how many"). A 2px column before every Monday carries a hairline week
 * divider. Renders nothing at 0 active habits, same rule the card it replaces
 * already followed (#905 AK7).
 */
export function HabitHistoryCard() {
  const habits = useHabits();
  const logs = useHabitLogs();

  if (habits === undefined || logs === undefined) return null;

  const active = habits.filter((habit) => habit.archivedAt === null).sort(compareHabits);
  if (active.length === 0) return null;

  const now = new Date();
  const grid = historyGrid(habits, logs, now);
  const { gridTemplateColumns, dayColumns, weekLineColumns } = weekLayout(grid.days);

  return (
    <div className="habit-history-card">
      <div className="habit-history-card__head">
        <p className="habit-history-card__label">Erledigt · 30 Tage</p>
        <p className="habit-history-card__value">{grid.total}</p>
      </div>
      <div
        className="habit-history-card__grid"
        style={{
          gridTemplateColumns,
          gridTemplateRows: `repeat(${active.length}, minmax(0, 14px))`,
        }}
        role="img"
        aria-label={`${grid.total} Erledigungen in den letzten 30 Tagen`}
      >
        {weekLineColumns.map((column) => (
          <span
            key={`week-${column}`}
            className="habit-history-card__week-line"
            style={{ gridColumn: column, gridRow: '1 / -1' }}
          />
        ))}
        {active.map((habit, rowIndex) =>
          grid.days.map((day, dayIndex) => {
            const done = isHabitDoneOnDay(day, habit.id);
            return (
              <span
                key={`${habit.id}-${day.dateKey}`}
                className="habit-history-card__cell"
                style={{
                  gridColumn: dayColumns[dayIndex],
                  gridRow: rowIndex + 1,
                  background: done ? (habit.emoji ? 'transparent' : 'var(--area-habits)') : undefined,
                }}
              >
                {done && habit.emoji ? (
                  <span className="habit-history-card__emoji" aria-hidden="true">
                    {habit.emoji}
                  </span>
                ) : null}
              </span>
            );
          }),
        )}
      </div>
      <div className="habit-history-card__axis">
        <span>vor 30 Tagen</span>
        <span>heute</span>
      </div>
    </div>
  );
}
