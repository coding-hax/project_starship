'use client';

import { useMemo, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { SegmentedControl } from '@/ui/segmented-control';
import { addDays, addMonthsClamped, categoriesForDay, categoryEdgeVar, formatMonthTitle, monthDaysFor } from './event-time';
import { expandForDay } from './recurrence';
import type { EventExceptionView } from './use-event-exceptions';
import type { EventView } from './use-events';

type StripView = 'woche' | 'monat';

const VIEW_OPTIONS: { value: StripView; label: string }[] = [
  { value: 'woche', label: 'Woche' },
  { value: 'monat', label: 'Monat' },
];

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Past this delta on the locked axis, releasing is a swipe, not a tap — applies to both axes. */
const SWIPE_THRESHOLD_PX = 48;
/** Movement at or below this still counts as a tap — the day button's own click fires normally. */
const TAP_TOLERANCE_PX = 8;
/** Past this delta on either axis, the gesture locks to whichever axis moved further (issue #629). */
const AXIS_LOCK_PX = 12;

export interface CalendarStripProps {
  selectedDay: string;
  onSelectDay: (dateKey: string) => void;
  /** Today's Berlin date key — marks the current day (`data-today`) in the grid. */
  today: string;
  events: EventView[];
  /** `event_exceptions` rows — same input the timeline gets, so a cancelled or
   *  moved instance drops out of the dots too (issue #612). */
  exceptions: EventExceptionView[];
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
  exceptions,
  expanded,
  onExpandChange,
}: CalendarStripProps) {
  const days = useMemo(() => monthDaysFor(selectedDay), [selectedDay]);
  const weeks = useMemo(() => chunkIntoWeeks(days), [days]);
  /**
   * One `expandForDay` pass per rendered day (35 or 42) — the same call the
   * timeline makes for the selected day, so the dots agree with it by
   * construction instead of by a second, parallel rule (issue #612). Memoised
   * because every row is rendered whether or not the month is expanded.
   */
  const dotsByDay = useMemo(
    () =>
      new Map(
        days.map((day) => [day, categoriesForDay(expandForDay(events, exceptions, day), day)]),
      ),
    [days, events, exceptions],
  );
  const selectedMonth = selectedDay.slice(0, 7);
  const startXRef = useRef<number | null>(null);
  const startYRef = useRef<number | null>(null);
  const lockedAxisRef = useRef<'x' | 'y' | null>(null);
  const movedRef = useRef(false);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    startXRef.current = event.clientX;
    startYRef.current = event.clientY;
    lockedAxisRef.current = null;
    movedRef.current = false;
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (startXRef.current === null || startYRef.current === null) return;
    const dx = event.clientX - startXRef.current;
    const dy = event.clientY - startYRef.current;
    if (lockedAxisRef.current === null && Math.max(Math.abs(dx), Math.abs(dy)) > AXIS_LOCK_PX) {
      lockedAxisRef.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    const guidedDelta = lockedAxisRef.current === 'x' ? dx : dy;
    if (lockedAxisRef.current !== null && Math.abs(guidedDelta) > TAP_TOLERANCE_PX) {
      movedRef.current = true;
    }
  }

  function endGesture(event: ReactPointerEvent<HTMLDivElement>) {
    if (startXRef.current === null || startYRef.current === null) return;
    const dx = event.clientX - startXRef.current;
    const axis = lockedAxisRef.current;
    startXRef.current = null;
    startYRef.current = null;
    lockedAxisRef.current = null;
    if (axis === 'x' && Math.abs(dx) > SWIPE_THRESHOLD_PX) {
      // Left (dx<0) pages forward, right pages back — a week in week view
      // (addDays, ±7 always lands on the same weekday, issue #629, AK3), a
      // month in month view (addMonthsClamped, same day-of-month, clamped at
      // the month's end, issue #662, AK-B). A vertical swipe only locks the
      // axis so a vertically guided pointer can't accidentally page — it has
      // no effect of its own; the segmented control is the only way to
      // switch week/month (issue #662, AK-A).
      onSelectDay(
        expanded
          ? addMonthsClamped(selectedDay, dx < 0 ? 1 : -1)
          : addDays(selectedDay, dx < 0 ? 7 : -7),
      );
    }
  }

  function cancelGesture() {
    startXRef.current = null;
    startYRef.current = null;
    lockedAxisRef.current = null;
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
      <div className="calendar-strip__title-row">
        <p className="calendar-strip__title">{formatMonthTitle(selectedDay)}</p>
        <SegmentedControl
          options={VIEW_OPTIONS}
          value={expanded ? 'monat' : 'woche'}
          onChange={(next) => onExpandChange(next === 'monat')}
          label="Ansicht"
        />
      </div>
      <div className="calendar-strip__toolbar">
        <button
          type="button"
          className="calendar-strip__nav"
          aria-label="Vorheriger Tag"
          onClick={() => onSelectDay(addDays(selectedDay, -1))}
        >
          <IconChevronLeft />
        </button>
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
                  const dots = dotsByDay.get(day) ?? [];
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
