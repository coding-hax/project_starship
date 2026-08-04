'use client';

import { useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { addDays, categoriesForDay, categoryEdgeVar, monthDaysFor } from './event-time';
import type { EventView } from './use-events';

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Past this vertical delta, releasing is a swipe, not a tap. */
const SWIPE_THRESHOLD_PX = 48;
/** Movement at or below this still counts as a tap — the day button's own click fires normally. */
const TAP_TOLERANCE_PX = 8;

export interface CalendarStripProps {
  selectedDay: string;
  onSelectDay: (dateKey: string) => void;
  /** Today's Berlin date key — marks the current day and drives the "Heute" button. */
  today: string;
  events: EventView[];
  /** Auf (Monat) oder zu (Wochenstreifen) — issue #556, S5. */
  expanded: boolean;
  onExpandChange: (next: boolean) => void;
}

function chunkIntoWeeks(days: string[]): string[][] {
  const weeks: string[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }
  return weeks;
}

/**
 * Week strip that pulls open into a full month (issue #556, S5 of #473 — a
 * fixed Mon–Sun strip in S2/#553, then called "week-strip"). Every week of the
 * month is always rendered; `expanded` only toggles which rows are visually
 * revealed (CSS `grid-template-rows`, calendar-strip.css) — never a remount,
 * so the dots per day (`categoriesForDay`) are computed once regardless of state.
 */
export function CalendarStrip({
  selectedDay,
  onSelectDay,
  today,
  events,
  expanded,
  onExpandChange,
}: CalendarStripProps) {
  const weeks = chunkIntoWeeks(monthDaysFor(selectedDay));
  const selectedMonth = selectedDay.slice(0, 7);
  const startYRef = useRef<number | null>(null);
  const movedRef = useRef(false);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    startYRef.current = event.clientY;
    movedRef.current = false;
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (startYRef.current === null) return;
    if (Math.abs(event.clientY - startYRef.current) > TAP_TOLERANCE_PX) {
      movedRef.current = true;
    }
  }

  function endGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (startYRef.current === null) return;
    const deltaY = event.clientY - startYRef.current;
    startYRef.current = null;
    if (deltaY > SWIPE_THRESHOLD_PX && !expanded) {
      onExpandChange(true);
    } else if (deltaY < -SWIPE_THRESHOLD_PX && expanded) {
      onExpandChange(false);
    }
  }

  function cancelGesture() {
    startYRef.current = null;
    movedRef.current = false;
  }

  /**
   * Swallows the click a genuine swipe would otherwise still fire on the day
   * button it started on — pointerdown and pointerup land on the same button
   * whenever nothing in the DOM shifts mid-gesture (no live-follow visual, the
   * state only flips on release). A tap never sets `movedRef` (it stays under
   * `TAP_TOLERANCE_PX`), so `onSelectDay` still fires for a real tap.
   */
  function handleClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    if (movedRef.current) {
      event.preventDefault();
      event.stopPropagation();
      movedRef.current = false;
    }
  }

  function selectDay(day: string) {
    onSelectDay(day);
    if (expanded) onExpandChange(false);
  }

  return (
    <div className="calendar-strip" data-expanded={expanded}>
      <div className="calendar-strip__toolbar">
        <button
          type="button"
          className="calendar-strip__nav"
          aria-label="Vorheriger Tag"
          onClick={() => onSelectDay(addDays(selectedDay, -1))}
        >
          <IconChevronLeft />
        </button>
        {selectedDay !== today && (
          <button
            type="button"
            className="calendar-strip__today"
            aria-label="Heute"
            onClick={() => onSelectDay(today)}
          >
            Heute
          </button>
        )}
        <button
          type="button"
          className="calendar-strip__nav"
          aria-label="Nächster Tag"
          onClick={() => onSelectDay(addDays(selectedDay, 1))}
        >
          <IconChevronRight />
        </button>
      </div>
      <ul className="calendar-strip__weekday-header" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
      <div
        className="calendar-strip__weeks"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endGesture}
        onPointerCancel={cancelGesture}
        onClickCapture={handleClickCapture}
      >
        {weeks.map((week) => {
          const isSelectedWeek = week.includes(selectedDay);
          return (
            <div
              key={week[0]}
              className="calendar-strip__week-row"
              data-selected={isSelectedWeek ? '' : undefined}
              inert={!expanded && !isSelectedWeek}
            >
              <ul className="calendar-strip__days">
                {week.map((day, index) => {
                  const isSelected = day === selectedDay;
                  const isOutsideMonth = day.slice(0, 7) !== selectedMonth;
                  const dayNumber = Number(day.slice(-2));
                  const dots = categoriesForDay(events, day);
                  return (
                    <li key={day}>
                      <button
                        type="button"
                        className={
                          isSelected
                            ? 'calendar-strip__day calendar-strip__day--selected'
                            : 'calendar-strip__day'
                        }
                        data-today={day === today ? '' : undefined}
                        data-outside-month={isOutsideMonth ? '' : undefined}
                        aria-pressed={isSelected}
                        aria-label={`${WEEKDAY_LABELS[index]}, ${dayNumber}.`}
                        onClick={() => selectDay(day)}
                      >
                        <span aria-hidden="true">{dayNumber}</span>
                        {dots.length > 0 && (
                          <span className="calendar-strip__dots" aria-hidden="true">
                            {dots.map((category) => (
                              <span
                                key={category ?? 'none'}
                                className="calendar-strip__dot"
                                style={{ background: categoryEdgeVar(category) }}
                              />
                            ))}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}
