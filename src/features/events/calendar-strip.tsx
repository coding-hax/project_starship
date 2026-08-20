'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { SegmentedControl } from '@/ui/segmented-control';
import {
  addDays,
  categoriesForDay,
  categoryEdgeVar,
  formatMonthTitle,
  monthDaysFor,
  pageAnchors,
  weekDaysFor,
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

/** Explicit `behavior: 'smooth'` ignores CSS `scroll-behavior` (see nav.tsx) — so a
 *  JS-driven scroll has to check both motion sources itself, same as there. */
function prefersReducedMotion(): boolean {
  return (
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.getAttribute('data-reduce-motion') === 'true'
  );
}

/**
 * Week strip that pulls open into a full month (issue #556, S5 of #473 — a
 * fixed Mon–Sun strip in S2/#553, then called "week-strip").
 *
 * A native horizontal scroll-snap carousel (issue #805, Ansatz C — replaces
 * the pointer-driven scrub of #629/#662/#764/#802): a 3-page window
 * `[previous, current, next]` around `anchorDay`, one Mon–Sun week per page in
 * week view, one full month grid per page in month view. Swiping is entirely
 * native — the browser owns the drag, the momentum and the snap, this
 * component only reacts once a page has settled (`scrollend`, or a debounced
 * `scroll` fallback where that event doesn't exist yet). On settle it moves
 * `anchorDay` to the page that's now centred and re-centres the track
 * *without* animation — the classic 3-slide infinite-carousel trick, so the
 * window always has a page to glide to on the next swipe in either direction.
 *
 * `anchorDay` (issue #784) is a second, purely local state: it drives what
 * the grid/title show, `selectedDay` (the prop) drives only `aria-pressed`
 * and — one level up in calendar-view.tsx — the agenda below. Paging moves
 * only the anchor; tapping a day, the day-step arrows and "Heute" move both
 * (`selectDay` below).
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
  const scrollRef = useRef<HTMLDivElement>(null);

  /** Three pages, each carrying the anchor it was built from and the week
   *  rows to render — `weeks` is a single row in week view, five or six in
   *  month view (`monthDaysFor` pads to full Mon–Sun weeks either way). */
  const pages = useMemo(
    () =>
      pageAnchors(anchorDay, expanded).map((anchor) => ({
        anchor,
        weeks: chunkIntoWeeks(expanded ? monthDaysFor(anchor) : weekDaysFor(anchor)),
      })),
    [anchorDay, expanded],
  );
  const centerDays = useMemo(() => pages[1].weeks.flat(), [pages]);
  /**
   * One `expandForDay` pass per day across all three pages — the same call
   * the timeline makes for the selected day, so the dots agree with it by
   * construction instead of by a second, parallel rule (issue #612). A day
   * can appear in two neighbouring pages near a month boundary (once as its
   * own page's day, once dimmed as a neighbour-month day in the other) — the
   * map just computes the same dots twice for it, harmlessly.
   */
  const dotsByDay = useMemo(() => {
    const allDays = pages.flatMap((page) => page.weeks.flat());
    return new Map(
      allDays.map((day) => [day, categoriesForDay(expandForDay(events, exceptions, day), day)]),
    );
  }, [pages, events, exceptions]);
  // "Heute" is inactive only once both states already agree with today —
  // otherwise the chip stays the only way back (issue #784, AK6).
  const todayVisible = centerDays.includes(today);
  const todayInactive = selectedDay === today && todayVisible;

  /** Re-centres the track on the current page, instantly — runs after every
   *  window rebuild (a settled swipe, a button page, a tap/"Heute" jump, or
   *  the Woche/Monat switch), always before paint so the reset is invisible. */
  useLayoutEffect(() => {
    const track = scrollRef.current;
    if (!track) return;
    track.scrollLeft = track.clientWidth;
  }, [pages]);

  /** Settles a swipe once the browser has finished snapping: whichever page
   *  the track landed on becomes the new anchor (the centre page settling
   *  back onto itself is a no-op). `scrollend` is the direct signal and fires
   *  promptly wherever it's supported; the debounced `scroll` listener is a
   *  fallback for browsers without it yet (iOS Safari) — momentum scrolling
   *  fires `scroll` continuously, so waiting for it to go quiet is the only
   *  way to tell the gesture actually finished there. Both run unconditionally
   *  rather than feature-detecting `scrollend` (its type is unconditionally
   *  present on every DOM element, so an `in` check can't tell browsers apart
   *  at compile time) — `settle` is idempotent, so a redundant second call
   *  costs nothing. */
  useEffect(() => {
    const track = scrollRef.current;
    if (!track) return;

    function settle() {
      const current = scrollRef.current;
      if (!current) return;
      const width = current.clientWidth;
      if (width === 0) return;
      const index = Math.round(current.scrollLeft / width);
      if (index === 1) return;
      const anchor = pages[index]?.anchor;
      if (anchor) setAnchorDay(anchor);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    function onScroll() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(settle, 120);
    }

    track.addEventListener('scrollend', settle);
    track.addEventListener('scroll', onScroll);
    return () => {
      track.removeEventListener('scrollend', settle);
      track.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [pages]);

  /** Sets selection *and* re-anchors the view on it — tap, day-step arrows and "Heute" all funnel through here (issue #784, AK4/AK6/AK7). Jumps straight there, no animation, however far the target is. */
  function selectDay(day: string) {
    onSelectDay(day);
    setAnchorDay(day);
  }

  /**
   * Pages a week in week view, a month in month view — the desktop `‹`/`›`
   * buttons' own source (issue #630, AK9). Moves only the anchor, leaving the
   * selection untouched (issue #784, AK7). Unlike `selectDay`'s instant jump,
   * this glides to the already-rendered neighbour page — the same settle
   * path a swipe takes picks the glide up once it lands and re-anchors.
   */
  function pageBy(delta: 1 | -1) {
    const track = scrollRef.current;
    if (!track) return;
    track.scrollTo({
      left: (1 + delta) * track.clientWidth,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
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
      <div className="calendar-strip__carousel" ref={scrollRef}>
        {pages.map((page, index) => {
          const isCentered = index === 1;
          return (
            <div
              key={page.anchor}
              className="calendar-strip__page"
              // Off-screen pages of the carousel (issue #805) — neither
              // focusable nor announced, replaces the old per-row `inert`
              // the accordion trick used.
              inert={!isCentered}
              aria-hidden={isCentered ? undefined : true}
            >
              {page.weeks.map((week) => (
                <ul className="calendar-strip__days" key={week[0]}>
                  {week.map((day, dayIndex) => {
                    // Only the centred page can ever read as selected — a
                    // day of the same date-of-month in a neighbour page (or
                    // the previous/next carousel page entirely) is a clean
                    // "nothing pressed" state, not a stale mark (issue #784, AK5).
                    const isSelected = isCentered && day === selectedDay;
                    const isOutsideMonth = day.slice(0, 7) !== page.anchor.slice(0, 7);
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
                          aria-label={`${WEEKDAY_LABELS[dayIndex]}, ${dayNumber}.`}
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
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
