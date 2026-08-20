'use client';

import {
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { SegmentedControl } from '@/ui/segmented-control';
import {
  addDays,
  addMonthsClamped,
  categoriesForDay,
  categoryEdgeVar,
  DRAG_TAP_TOLERANCE_PX,
  dragDayDelta,
  dragWeekDelta,
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
 *
 * `anchorDay` (issue #784) is a second, purely local state: it drives what
 * the grid/title show, `selectedDay` (the prop) drives only `aria-pressed`
 * and — one level up in calendar-view.tsx — the agenda below. Dragging and
 * paging move only the anchor; tapping a day, the day-step arrows and "Heute"
 * move both (`selectDay` below). Before #784 there was only one state, so a
 * drag paged the agenda along with it — exactly the bug this splits apart.
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
  const [anchorDay, setAnchorDay] = useState(selectedDay);
  const days = useMemo(() => monthDaysFor(anchorDay), [anchorDay]);
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
  const anchorMonth = anchorDay.slice(0, 7);
  // The one row the collapsed (week) view keeps expanded — always found,
  // `days`/`weeks` are themselves built from `anchorDay`.
  const anchorWeek = useMemo(() => weeks.find((week) => week.includes(anchorDay)) ?? [], [weeks, anchorDay]);
  // "Heute" is inactive only once both states already agree with today —
  // otherwise the chip stays the only way back (issue #784, AK6).
  const todayVisible = expanded ? days.includes(today) : anchorWeek.includes(today);
  const todayInactive = selectedDay === today && todayVisible;
  const startXRef = useRef<number | null>(null);
  const startYRef = useRef<number | null>(null);
  const lockedAxisRef = useRef<'x' | 'y' | null>(null);
  const movedRef = useRef(false);
  const scrubStartAnchorRef = useRef<string | null>(null);

  /** Sets selection *and* re-anchors the view on it — tap, day-step arrows and "Heute" all funnel through here (issue #784, AK4/AK6/AK7). */
  function selectDay(day: string) {
    onSelectDay(day);
    setAnchorDay(day);
  }

  /**
   * Pages a week in week view, a month in month view — the desktop `‹`/`›`
   * buttons' own source (issue #630, AK9). Moves only the anchor, leaving
   * the selection (and with it the agenda) untouched — the same split the
   * drag gesture below uses, so button and gesture never disagree about
   * what paging means (issue #784, AK7, replacing the AK9 assumption that
   * these buttons drove the selection).
   */
  function pageBy(delta: 1 | -1) {
    setAnchorDay(expanded ? addMonthsClamped(anchorDay, delta) : addDays(anchorDay, delta * 7));
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    startXRef.current = event.clientX;
    startYRef.current = event.clientY;
    lockedAxisRef.current = null;
    movedRef.current = false;
    scrubStartAnchorRef.current = anchorDay;
  }

  /**
   * Live-scrub (issue #764): the view anchor follows the pointer during the
   * drag itself, no waiting for release — the selection is left alone
   * (issue #784, AK1/AK2, the bug this ticket fixes: a drag used to move
   * the selection along with the view). Week view scrubs on the horizontal
   * axis in day steps, month view on the vertical one in whole-week steps
   * (issue #802 — dragging through a month grid pages by week, not by day) —
   * the other axis only locks (so a diagonal drag can't also page) and never
   * moves the anchor, same as the old axis-lock-swallows-the-other-axis rule
   * (#629/#662 AK-A). The day offset is always taken from the day the
   * gesture *started* on (`scrubStartAnchorRef`), not the live-updated
   * `anchorDay`, so the mapping from drag distance to day count stays
   * absolute instead of compounding with every move event.
   */
  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (startXRef.current === null || startYRef.current === null || scrubStartAnchorRef.current === null) {
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
    // Month view steps whole weeks (issue #802), week view steps single days.
    const dayOffset = expanded ? -dragWeekDelta(guidedDelta) * 7 : -dragDayDelta(guidedDelta);
    setAnchorDay(addDays(scrubStartAnchorRef.current, dayOffset));
  }

  /** Release just ends the gesture — the last live-scrubbed anchor already is the view, no snap-back (issue #764, AK3). */
  function endGesture() {
    startXRef.current = null;
    startYRef.current = null;
    lockedAxisRef.current = null;
    scrubStartAnchorRef.current = null;
  }

  function cancelGesture() {
    startXRef.current = null;
    startYRef.current = null;
    lockedAxisRef.current = null;
    movedRef.current = false;
    scrubStartAnchorRef.current = null;
  }

  /**
   * Swallows the click a genuine drag would otherwise still fire on whatever
   * day button now sits under the pointer at release — with live-scrub
   * (issue #764) that's not necessarily the button the gesture started on,
   * since the grid re-renders around the pointer as the anchor moves. A
   * tap never sets `movedRef` (it stays under `DRAG_TAP_TOLERANCE_PX`), so
   * `selectDay` still fires for a real tap.
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
          data-today-selected={todayInactive ? '' : undefined}
          disabled={todayInactive}
          onClick={() => selectDay(today)}
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
        <p className="calendar-strip__title">{formatMonthTitle(anchorDay)}</p>
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
          onClick={() => selectDay(addDays(selectedDay, -1))}
        >
          <IconChevronLeft />
        </button>
        <button
          type="button"
          className="calendar-strip__nav"
          aria-label="Nächster Tag"
          onClick={() => selectDay(addDays(selectedDay, 1))}
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
          const isAnchorWeek = week === anchorWeek;
          // Only a day inside the currently visible row can ever read as
          // selected — outside it (collapsed week view showing a different
          // week, or a drag that has carried the anchor away entirely) the
          // selection is a clean "nothing pressed" state, not a stale mark
          // on a hidden button (issue #784, AK5).
          const isRowVisible = expanded || isAnchorWeek;
          return (
            <div
              key={week[0]}
              className="calendar-strip__week-row"
              data-selected={isAnchorWeek ? '' : undefined}
              inert={!expanded && !isAnchorWeek}
            >
              <ul className="calendar-strip__days">
                {week.map((day, index) => {
                  const isSelected = isRowVisible && day === selectedDay;
                  const isOutsideMonth = day.slice(0, 7) !== anchorMonth;
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
