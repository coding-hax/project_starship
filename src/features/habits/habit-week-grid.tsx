'use client';

import { toDateKey, weekDays } from './due-today';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export interface HabitWeekGridProps {
  habit: HabitView;
  logs: HabitLogView[];
  onToggle: (habitId: string, logDate: string) => void;
  now?: Date;
}

/**
 * Compact Mon–Sun row per habit (issue #105), read straight from the same
 * `habit_logs` live query as the Heute checklist. A tap re-uses
 * `useToggleHabitLog`'s upsert-by-existing-row lookup, so a cell here and a
 * checkbox there never race `UNIQUE(habit_id, log_date)` with two inserts.
 */
export function HabitWeekGrid({ habit, logs, onToggle, now = new Date() }: HabitWeekGridProps) {
  const days = weekDays(now);
  const today = toDateKey(now);

  return (
    <ul className="habit-week-grid" aria-label={`Woche: ${habit.name}`}>
      {days.map((day, index) => {
        const done = logs.some(
          (log) => log.habitId === habit.id && log.logDate === day && log.done,
        );
        const isToday = day === today;
        const label = `${WEEKDAY_LABELS[index]}${isToday ? ' (heute)' : ''}: ${habit.name} ${
          done ? 'erledigt' : 'offen'
        }`;

        return (
          <li key={day} className="habit-week-grid__cell">
            <button
              type="button"
              className={
                done
                  ? 'habit-week-grid__day habit-week-grid__day--done'
                  : 'habit-week-grid__day'
              }
              data-today={isToday ? '' : undefined}
              style={done ? { background: `var(${habit.color ?? '--area-habits'})` } : undefined}
              aria-pressed={done}
              aria-label={label}
              onClick={() => onToggle(habit.id, day)}
            >
              <span aria-hidden="true">{WEEKDAY_LABELS[index]}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
