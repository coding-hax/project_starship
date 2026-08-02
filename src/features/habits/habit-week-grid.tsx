'use client';

import { dayLabel, monthDays, toDateKey } from './due-today';
import type { HabitLogView } from './use-habit-logs';
import type { HabitView } from './use-habits';

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export interface HabitWeekGridProps {
  habit: HabitView;
  logs: HabitLogView[];
  onToggle: (habitId: string, logDate: string) => void;
  /** First-of-month anchor for the month currently shown (issue #124). */
  viewedMonth: Date;
  now?: Date;
}

/**
 * Month grid per habit (issue #124, replaces the Mon–Sun row from #105), read
 * straight from the same `habit_logs` live query as the Übersicht checklist. A tap
 * re-uses `useToggleHabitLog`'s upsert-by-existing-row lookup, so a cell here
 * and a checkbox there never race `UNIQUE(habit_id, log_date)` with two inserts.
 */
export function HabitWeekGrid({
  habit,
  logs,
  onToggle,
  viewedMonth,
  now = new Date(),
}: HabitWeekGridProps) {
  const days = monthDays(viewedMonth);
  const today = toDateKey(now);

  return (
    <div className="habit-week-grid-wrap">
      <ul className="habit-week-grid__weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
      <ul className="habit-week-grid" aria-label={`Monat: ${habit.name}`}>
        {days.map(({ dateKey: day, inMonth }) => {
          const done = logs.some(
            (log) => log.habitId === habit.id && log.logDate === day && log.done,
          );
          // No isCurrentMonth gate here (issue #487 AC6) — "heute" is marked
          // wherever today's date key lands, including as a neighbour day.
          const isToday = day === today;
          const isFuture = day > today;
          const dayNumber = Number(day.slice(-2));
          const label = `${dayLabel(day)}${isToday ? ' (heute)' : ''}: ${habit.name} ${
            isFuture ? 'in der Zukunft' : done ? 'erledigt' : 'offen'
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
                data-future={isFuture ? '' : undefined}
                data-outside={inMonth ? undefined : ''}
                disabled={isFuture}
                style={done ? { background: `var(${habit.color ?? '--area-habits'})` } : undefined}
                aria-pressed={isFuture ? undefined : done}
                aria-label={label}
                onClick={() => onToggle(habit.id, day)}
              >
                <span aria-hidden="true">{dayNumber}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
