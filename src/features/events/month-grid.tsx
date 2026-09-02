'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
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

/** No further `scroll` events for this long counts as "settled" — the same
 *  hand-rolled `scrollend` fallback `calendar-strip.tsx` carries (issue #822:
 *  the native event is known to go missing on some engines once
 *  `scroll-snap-type` is in the mix). */
const SCROLL_IDLE_MS = 150;

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
 *  alignment — padded here to always 42 (six full Mon–Sun weeks) so no page
 *  ever changes the card's height (AK8). */
function gridDaysFor(focusMonth: string): string[] {
  const days = monthDaysFor(`${focusMonth}-01`);
  if (days.length === 42) return days;
  const extraWeek = weekDaysFor(addDays(days[days.length - 1], 1));
  return [...days, ...extraWeek];
}

function monthBefore(focusMonth: string): string {
  return addMonthsClamped(`${focusMonth}-15`, -1).slice(0, 7);
}

function monthAfter(focusMonth: string): string {
  return addMonthsClamped(`${focusMonth}-15`, 1).slice(0, 7);
}

interface MonthPageProps {
  pageMonth: string;
  interactive: boolean;
  selectedDay: string;
  today: string;
  events: EventView[];
  exceptions: EventExceptionView[];
  onSelect: (day: string) => void;
}

/** One of the track's three rendered months. Non-central pages are `inert` +
 *  `aria-hidden` (same recipe as `calendar-strip.tsx`'s buffered cells) —
 *  without it, a day shared between a month page and its neighbour-month
 *  dimmed rendering (e.g. "Mo, 3." on both the July and the August page)
 *  would produce two matching `aria-label`s and a strict-mode double hit for
 *  any locator keyed off it. */
function MonthPage({
  pageMonth,
  interactive,
  selectedDay,
  today,
  events,
  exceptions,
  onSelect,
}: MonthPageProps) {
  const days = useMemo(() => gridDaysFor(pageMonth), [pageMonth]);

  /** One `expandForDay` pass per day across this page — the same call the
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

  return (
    <div className="month-grid__page" inert={!interactive} aria-hidden={interactive ? undefined : true}>
      <ul className="month-grid__days">
        {days.map((day, index) => {
          const dayNumber = Number(day.slice(-2));
          const isSelected = day === selectedDay;
          const isOutsideMonth = day.slice(0, 7) !== pageMonth;
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
                onClick={() => onSelect(day)}
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

/**
 * Month card in `/kalender`'s body (issue #958, T1 of #957; wiped free of its
 * nav buttons and made swipeable in issue #1009) — the month view's only
 * calendar surface; `calendar-strip.tsx` stays a pure week strip. Three whole
 * months (prev/current/next) sit in a horizontal `scroll-snap-type: x
 * mandatory` track; a swipe snaps to a neighbour page, which is reported up
 * via `onFocusMonth` once it settles, and the track silently recentres on the
 * new middle page before paint — the same buffered-window-plus-silent-recentre
 * shape `calendar-strip.tsx` uses for days, just three whole-page units
 * instead of a rolling day buffer. Tapping a day (only ever possible on the
 * interactive middle page) also moves the focused month onto that day's
 * month.
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
  const trackRef = useRef<HTMLDivElement>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const prevMonth = useMemo(() => monthBefore(focusMonth), [focusMonth]);
  const nextMonth = useMemo(() => monthAfter(focusMonth), [focusMonth]);

  const handleSelect = useCallback(
    (day: string) => {
      onSelectDay(day);
      onFocusMonth(day.slice(0, 7));
    },
    [onSelectDay, onFocusMonth],
  );

  /** Recentres the track on the middle (current-month) page — runs after
   *  every `focusMonth` change (a tap or a settled swipe), always before
   *  paint so the jump back to the middle is never visible (mirrors
   *  `calendar-strip.tsx`'s silent re-anchor). */
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollLeft = track.clientWidth;
  }, [focusMonth]);

  /** Same settle-then-report pattern as `calendar-strip.tsx`: `scrollend` is
   *  the fast path, the `SCROLL_IDLE_MS` idle timer the fallback for engines
   *  where it goes missing once `scroll-snap-type` is involved (issue #822).
   *  Once scrolling has settled on a non-middle page, reports the neighbour
   *  month up — the resulting re-render shifts prev/current/next by one and
   *  the layout effect above recentres again, so a second swipe right after
   *  lands a further month over (AK7). */
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    function handleScrollEnd() {
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      const current = trackRef.current;
      if (!current) return;
      const pageWidth = current.clientWidth;
      if (pageWidth <= 0) return;
      const page = Math.round(current.scrollLeft / pageWidth);
      if (page <= 0) onFocusMonth(prevMonth);
      else if (page >= 2) onFocusMonth(nextMonth);
    }

    function handleScroll() {
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(handleScrollEnd, SCROLL_IDLE_MS);
    }

    track.addEventListener('scroll', handleScroll, { passive: true });
    track.addEventListener('scrollend', handleScrollEnd, { passive: true });
    return () => {
      track.removeEventListener('scroll', handleScroll);
      track.removeEventListener('scrollend', handleScrollEnd);
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [prevMonth, nextMonth, onFocusMonth]);

  return (
    <div className="month-grid" data-focus-month={focusMonth}>
      <ul className="month-grid__weekday-header" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
      <div className="month-grid__track" ref={trackRef}>
        <MonthPage
          pageMonth={prevMonth}
          interactive={false}
          selectedDay={selectedDay}
          today={today}
          events={events}
          exceptions={exceptions}
          onSelect={handleSelect}
        />
        <MonthPage
          pageMonth={focusMonth}
          interactive
          selectedDay={selectedDay}
          today={today}
          events={events}
          exceptions={exceptions}
          onSelect={handleSelect}
        />
        <MonthPage
          pageMonth={nextMonth}
          interactive={false}
          selectedDay={selectedDay}
          today={today}
          events={events}
          exceptions={exceptions}
          onSelect={handleSelect}
        />
      </div>
    </div>
  );
}
