'use client';

import { cellHabitId, historyGrid } from './history-grid';
import { legendOrder } from './legend-order';
import { useHabitLogs } from './use-habit-logs';
import { useHabits } from './use-habits';

/**
 * "Erledigt · 30 Tage" as a squares grid (issue #1070, replaces the step-chart
 * card from #905/#1040) — 30 columns of days, one row per active habit, each
 * done habit a filled square in its own color, stacked from the baseline in
 * `compareHabits` order so a reliable habit reads as an unbroken band instead
 * of jumping row on every miss. Renders nothing at 0 active habits, same rule
 * the card it replaces already followed (#905 AK7) — an empty grid would read
 * as "nothing happened" more loudly than silence.
 */
export function HabitHistoryCard() {
  const habits = useHabits();
  const logs = useHabitLogs();

  if (habits === undefined || logs === undefined) return null;

  const active = habits.filter((habit) => habit.archivedAt === null);
  if (active.length === 0) return null;

  const now = new Date();
  const grid = historyGrid(habits, logs, now);
  const rowCount = active.length;
  const habitById = new Map(active.map((habit) => [habit.id, habit]));

  return (
    <div className="habit-history-card">
      <div className="habit-history-card__head">
        <p className="habit-history-card__label">Erledigt · 30 Tage</p>
        <p className="habit-history-card__value">{grid.total}</p>
      </div>
      <div
        className="habit-history-card__grid"
        style={{ gridTemplateRows: `repeat(${rowCount}, minmax(0, 14px))` }}
        role="img"
        aria-label={`${grid.total} Erledigungen in den letzten 30 Tagen`}
      >
        {Array.from({ length: rowCount }, (_, rowIndex) =>
          grid.days.map((day) => {
            const habitId = cellHabitId(day, rowIndex, rowCount);
            const habit = habitId ? habitById.get(habitId) : undefined;
            return (
              <span
                key={`${rowIndex}-${day.dateKey}`}
                className="habit-history-card__cell"
                style={habit ? { background: `var(${habit.color ?? '--area-habits'})` } : undefined}
              />
            );
          }),
        )}
      </div>
      <div className="habit-history-card__axis">
        <span>vor 30 Tagen</span>
        <span>heute</span>
      </div>
      <ul className="habit-history-card__legend">
        {legendOrder(active).map((habit) => (
          <li key={habit.id} className="habit-history-card__legend-item">
            <span
              className="habit-history-card__legend-dot"
              style={{ background: `var(${habit.color ?? '--area-habits'})` }}
            />
            <span className="habit-history-card__legend-name">{habit.name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
