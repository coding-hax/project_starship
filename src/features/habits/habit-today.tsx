'use client';

import Link from 'next/link';
import { isDueToday, toDateKey } from './due-today';
import { computeStreak } from './streak';
import { useHabitLogs } from './use-habit-logs';
import { useHabits } from './use-habits';
import { useToggleHabitLog } from './use-toggle-habit-log';

/**
 * The daily check-off list (issue #103). Habits have no tab of their own
 * (docs/DESIGN_SYSTEM.md) — this sits on /heute next to the link into the
 * management screen (issue #102), which is the other entry point.
 *
 * Unlike the task list, a checked-off row stays in place rather than
 * disappearing: the tap that checked it is also how you undo it (AC2), so the
 * row has to stay reachable.
 */
export function HabitToday() {
  const habits = useHabits();
  const logs = useHabitLogs();
  const toggle = useToggleHabitLog(logs);

  if (habits === undefined || logs === undefined) return null;

  const active = habits.filter((habit) => habit.archivedAt === null);

  if (active.length === 0) {
    return (
      <p className="habit-today__empty">
        Noch keine Gewohnheiten.{' '}
        <Link href="/heute/gewohnheiten">Jetzt anlegen</Link>
      </p>
    );
  }

  const now = new Date();
  const today = toDateKey(now);
  const due = active.filter((habit) => isDueToday(habit, logs, now));

  if (due.length === 0) {
    return <p className="habit-today__empty">Für heute nichts offen.</p>;
  }

  return (
    <ul className="habit-today" aria-label="Gewohnheiten heute">
      {due.map((habit) => {
        const doneToday = logs.some(
          (log) => log.habitId === habit.id && log.logDate === today && log.done,
        );
        const streak = computeStreak(habit, logs, now);
        return (
          <li
            key={habit.id}
            className={
              doneToday ? 'habit-today__item habit-today__item--done' : 'habit-today__item'
            }
          >
            <span
              className="habit-today__color"
              style={{ background: `var(${habit.color ?? '--area-habits'})` }}
              aria-hidden="true"
            />
            <span className="habit-today__name">{habit.name}</span>
            {streak > 0 && (
              <span
                className="habit-today__streak"
                style={{ color: `var(${habit.color ?? '--area-habits'})` }}
                aria-label={`Streak: ${streak}`}
              >
                <span aria-hidden="true">🔥</span> {streak}
              </span>
            )}
            <span className="habit-today__checkbox-wrap">
              <input
                type="checkbox"
                className="habit-today__checkbox"
                checked={doneToday}
                onChange={() => toggle(habit.id, today)}
                aria-label={`${habit.name} für heute abhaken`}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}
