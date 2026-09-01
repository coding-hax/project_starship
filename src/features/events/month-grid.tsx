'use client';

import { useCallback, useMemo, type CSSProperties } from 'react';
import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import {
  addDays,
  addMonthsClamped,
  categoriesForDay,
  categoryEdgeVar,
  monthDaysFor,
  weekDaysFor,
} from './event-time';
import { expandForDay } from './recurrence';
import type { EventExceptionView } from './use-event-exceptions';
import type { EventView } from './use-events';

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Dot cap for the card — tighter than the week strip's 4 (`categoriesForDay`'s
 *  default), the card's cells are narrower (issue #958, AK3). */
const MAX_DOTS_IN_GRID = 3;

export interface MonthGridProps {
  /** `YYYY-MM` — the month this card renders, driven by calendar-view.tsx's own
   *  state, not derived from `selectedDay`. */
  focusMonth: string;
  selectedDay: string;
  today: string;
  events: EventView[];
  exceptions: EventExceptionView[];
  onSelectDay: (dateKey: string) => void;
  onFocusMonth: (focusMonth: string) => void;
}

/** `monthDaysFor` returns 35 or 42 keys depending on the month's weekday
 *  alignment — padded here to always 42 (six full Mon–Sun weeks) so the card
 *  never changes height across a month change (same "kein Layout-Shift"
 *  reasoning the old carousel's fixed six-row height carried). */
function gridDaysFor(focusMonth: string): string[] {
  const days = monthDaysFor(`${focusMonth}-01`);
  if (days.length === 42) return days;
  const extraWeek = weekDaysFor(addDays(days[days.length - 1], 1));
  return [...days, ...extraWeek];
}

/**
 * Static month card in `/kalender`'s body (issue #958, T1 of #957) — the
 * month view's only calendar surface; `calendar-strip.tsx` stays a pure week
 * strip (its Woche-Zweig is untouched). No scrolling, no buffer, no
 * `windowAnchor`: `focusMonth` is the only state driving what's shown, paged
 * in whole months by the two nav buttons, or by tapping a day (which also
 * moves the focused month onto that day's month — including a dimmed
 * neighbour-month day).
 */
export function MonthGrid({
  focusMonth,
  selectedDay,
  today,
  events,
  exceptions,
  onSelectDay,
  onFocusMonth,
}: MonthGridProps) {
  const days = useMemo(() => gridDaysFor(focusMonth), [focusMonth]);

  /** One `expandForDay` pass per day across the card — the same call the
   *  timeline makes for the selected day, so the dots agree with it by
   *  construction (issue #612). */
  const dotsByDay = useMemo(
    () =>
      new Map(
        days.map((day) => [
          day,
          categoriesForDay(expandForDay(events, exceptions, day), day, MAX_DOTS_IN_GRID),
        ]),
      ),
    [days, events, exceptions],
  );

  const handleSelect = useCallback(
    (day: string) => {
      onSelectDay(day);
      onFocusMonth(day.slice(0, 7));
    },
    [onSelectDay, onFocusMonth],
  );

  function pageBy(delta: 1 | -1) {
    onFocusMonth(addMonthsClamped(`${focusMonth}-15`, delta).slice(0, 7));
  }

  return (
    <div className="month-grid">
      <div className="month-grid__nav">
        <button
          type="button"
          className="month-grid__nav-button"
          aria-label="Voriger Monat"
          onClick={() => pageBy(-1)}
        >
          <IconChevronLeft />
        </button>
        <button
          type="button"
          className="month-grid__nav-button"
          aria-label="Nächster Monat"
          onClick={() => pageBy(1)}
        >
          <IconChevronRight />
        </button>
      </div>
      <ul className="month-grid__weekday-header" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
      <ul className="month-grid__days">
        {days.map((day, index) => {
          const dayNumber = Number(day.slice(-2));
          const isSelected = day === selectedDay;
          const isOutsideMonth = day.slice(0, 7) !== focusMonth;
          return (
            <li key={day}>
              <button
                type="button"
                className={
                  isSelected ? 'month-grid__day month-grid__day--selected' : 'month-grid__day'
                }
                data-today={day === today ? '' : undefined}
                data-outside-month={isOutsideMonth ? '' : undefined}
                aria-pressed={isSelected}
                aria-label={`${WEEKDAY_LABELS[index % 7]}, ${dayNumber}.`}
                onClick={() => handleSelect(day)}
              >
                <span aria-hidden="true">{dayNumber}</span>
                <span className="month-grid__dots" aria-hidden="true">
                  {(dotsByDay.get(day) ?? []).map((category) => (
                    <span
                      key={category ?? 'none'}
                      className="month-grid__dot"
                      style={{ '--dot-cat': categoryEdgeVar(category) } as CSSProperties}
                    />
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
