'use client';

import { useMemo, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { SegmentedControl } from '@/ui/segmented-control';
import {
  addDays,
  addMonthsClamped,
  categoriesForDay,
  categoryEdgeVar,
  DRAG_TAP_TOLERANCE_PX,
  dragDayDelta,
  formatMonthTitle,
  monthDaysFor,
} from './event-time';
import { expandForDay } from './recurrence';
import type { EventExceptionView } from './use-event-exceptions';
import type { EventView } from './use-events';

type StripView = 'woche' | 'monat';

const VIEW_OPTIONS: { value: StripView; label: string }[] = [
  { value: 'woche', label: 'Woche' },
  { value: 'monat', label: 'Monat' },
];

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

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
  const isToday = selectedDay === today;
  const startXRef = useRef<number | null>(null);
  const startYRef = useRef<number | null>(null);
  const lockedAxisRef = useRef<'x' | 'y' | null>(null);
  const movedRef = useRef(false);
  const scrubStartDayRef = useRef<string | null>(null);

  /**
   * Pages a week in week view, a month in month view — the desktop `‹`/`›`
   * buttons' own source (issue #630, AK9). The drag gesture below no longer
   * shares this: it live-scrubs by day instead of paging by a fixed unit
   * (issue #764), so button and gesture intentionally give different jumps.
   */
  function pageBy(delta: 1 | -1) {
    onSelectDay(
      expanded ? addMonthsClamped(selectedDay, delta) : addDays(selectedDay, delta * 7),
    );
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    startXRef.current = event.clientX;
    startYRef.current = event.clientY;
    lockedAxisRef.current = null;
    movedRef.current = false;
    scrubStartDayRef.current = selectedDay;
  }

  /**
   * Live-scrub (issue #764): the selected day follows the pointer during the
   * drag itself, no waiting for release. Week view scrubs on the horizontal
   * axis, month view on the vertical one — the other axis only locks (so a
   * diagonal drag can't also page) and never moves the selection, same as
   * the old axis-lock-swallows-the-other-axis rule (#629/#662 AK-A). The day
   * offset is always taken from the day the gesture *started* on
   * (`scrubStartDayRef`), not the live-updated `selectedDay`, so the mapping
   * from drag distance to day count stays absolute instead of compounding
   * with every move event.
   */
  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (startXRef.current === null || startYRef.current === null || scrubStartDayRef.current === null) {
      return;
    }
    const dx = event.clientX - startXRef.current;
    const dy = event.clientY - startYRef.current;
    if (lockedAxisRef.current === null && Math.max(Math.abs(dx), Math.abs(dy)) > AXIS_LOCK_PX) {
      lockedAxisRef.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    const axis = lockedAxisRef.current;
    if (axis === null) return;
    const guidedDelta = axis === 'x' ? dx : dy;
    if (Math.abs(guidedDelta) > DRAG_TAP_TOLERANCE_PX) {
      movedRef.current = true;
    }
    const scrubAxis = expanded ? 'y' : 'x';
    if (axis !== scrubAxis) return;
    // Left/up (negative delta) advances, right/down goes back — same
    // direction as the old swipe-left-pages-forward rule, now continuous.
    const dayOffset = -dragDayDelta(guidedDelta);
    onSelectDay(addDays(scrubStartDayRef.current, dayOffset));
  }

  /** Release just ends the gesture — the last live-scrubbed day already is the selection, no snap-back (issue #764). */
  function endGesture() {
    startXRef.current = null;
    startYRef.current = null;
    lockedAxisRef.current = null;
    scrubStartDayRef.current = null;
  }

  function cancelGesture() {
    startXRef.current = null;
    startYRef.current = null;
    lockedAxisRef.current = null;
    movedRef.current = false;
    scrubStartDayRef.current = null;
  }

  /**
   * Swallows the click a genuine drag would otherwise still fire on whatever
   * day button now sits under the pointer at release — with live-scrub
   * (issue #764) that's not necessarily the button the gesture started on,
   * since the grid re-renders around the pointer as the selection moves. A
   * tap never sets `movedRef` (it stays under `DRAG_TAP_TOLERANCE_PX`), so
   * `onSelectDay` still fires for a real tap.
   */
  function handleClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    if (movedRef.current) {
      event.preventDefault();
      event.stopPropagation();
      movedRef.current = false;
    }
  }

  return (
    <div className="calendar-strip" data-expanded={expanded}>
      <div className="calendar-strip__title-row">
        {/* Same control at every width (issue #630, AK9/AK10) — a mobile-hidden
            chip that reappears on a different day (S1, #628 AK6) below
            768px, a disabled-not-removed toolbar button from 768px up
            (CSS alone switches the look, `data`-attribute drives the mobile
            hide so it never becomes two parallel elements). */}
        <button
          type="button"
          className="calendar-strip__today"
          data-today-selected={isToday ? '' : undefined}
          disabled={isToday}
          onClick={() => onSelectDay(today)}
        >
          Heute
        </button>
        <div className="calendar-strip__title-nav">
          <button
            type="button"
            className="calendar-strip__nav"
            aria-label={expanded ? 'Voriger Monat' : 'Vorige Woche'}
            onClick={() => pageBy(-1)}
          >
            <IconChevronLeft />
          </button>
          <button
            type="button"
            className="calendar-strip__nav"
            aria-label={expanded ? 'Nächster Monat' : 'Nächste Woche'}
            onClick={() => pageBy(1)}
          >
            <IconChevronRight />
          </button>
        </div>
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
                        onClick={() => onSelectDay(day)}
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
