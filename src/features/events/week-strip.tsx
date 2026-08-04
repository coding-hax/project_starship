'use client';

import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { addDays, weekDaysFor } from './event-time';

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

export interface WeekStripProps {
  selectedDay: string;
  onSelectDay: (dateKey: string) => void;
  /** Today's Berlin date key, marks the current day — purely visual. */
  today?: string;
}

/**
 * Collapsed week strip (issue #553, Owner-Entscheidung 5 — the expanding month
 * view is S5, #556): Mon–Sun around `selectedDay`, paged one day at a time via
 * the prev/next buttons, no swipe-to-expand gesture. Category dots per day are
 * S5 too, left out here.
 */
export function WeekStrip({ selectedDay, onSelectDay, today }: WeekStripProps) {
  const days = weekDaysFor(selectedDay);

  return (
    <div className="week-strip">
      <button
        type="button"
        className="week-strip__nav"
        aria-label="Vorheriger Tag"
        onClick={() => onSelectDay(addDays(selectedDay, -1))}
      >
        <IconChevronLeft />
      </button>
      <ul className="week-strip__days">
        {days.map((day, index) => {
          const isSelected = day === selectedDay;
          const dayNumber = Number(day.slice(-2));
          return (
            <li key={day}>
              <button
                type="button"
                className={
                  isSelected ? 'week-strip__day week-strip__day--selected' : 'week-strip__day'
                }
                data-today={day === today ? '' : undefined}
                aria-pressed={isSelected}
                aria-label={`${WEEKDAY_LABELS[index]}, ${dayNumber}.`}
                onClick={() => onSelectDay(day)}
              >
                <span className="week-strip__weekday" aria-hidden="true">
                  {WEEKDAY_LABELS[index]}
                </span>
                <span aria-hidden="true">{dayNumber}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="week-strip__nav"
        aria-label="Nächster Tag"
        onClick={() => onSelectDay(addDays(selectedDay, 1))}
      >
        <IconChevronRight />
      </button>
    </div>
  );
}
