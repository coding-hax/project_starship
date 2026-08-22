'use client';

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { SegmentedControl } from '@/ui/segmented-control';
import {
  addDays,
  addMonthsClamped,
  categoriesForDay,
  categoryEdgeVar,
  dateKeyDiff,
  dayWindow,
  formatMonthTitle,
  parseDateKey,
  weekDaysFor,
  weekWindow,
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

/** One screen's worth of columns/rows — the fixed size the carousel's CSS
 *  height and the buffer's "visible band" math are both built from. */
const VISIBLE_DAYS = 7;
const VISIBLE_WEEKS = 6;

/** Buffer radius either side of the anchor, in days/weeks — one year each way
 *  (issue #824: at the old 21-day/14-week radius, normal paging eventually
 *  reached the buffer edge, where the silent re-anchor's `SCROLL_IDLE_MS`
 *  settle wait became a felt pause). A year is far enough that ordinary
 *  paging never reaches the edge (~52 week-swipes, ~17 month-swipes), so the
 *  re-anchor stays a safety net rather than something normal use ever hits;
 *  memoised per-cell/per-row rendering below (`CalendarDayCell`/
 *  `CalendarWeekRow`) keeps the resulting 731 cells / 105 rows cheap to
 *  re-render. */
const RADIUS_DAYS = 365;
const RADIUS_WEEKS = 52;

/** How close to a buffer edge (in cells/rows) triggers a silent re-anchor —
 *  see the `useLayoutEffect` below for the scroll-position compensation that
 *  makes it invisible. */
const MARGIN_DAYS = 10;
const MARGIN_WEEKS = 8;

/** No further `scroll` events for this long counts as "settled" — a
 *  hand-rolled equivalent of the native `scrollend` event (issue #822: the
 *  buffer only ever re-anchored on `scrollend`, and that event is known to
 *  go missing on some engines once `scroll-snap-type` is in the mix — e.g. a
 *  proximity-snap correction that lands without ever firing one. When it
 *  silently never fires, the buffer never rebuilds and the strip is stuck
 *  wherever the initial `RADIUS_DAYS`/`RADIUS_WEEKS` window put its edges —
 *  a bounded few months, not "so gut wie unbegrenzt". Comfortably above a
 *  frame gap (~16ms) so it never fires mid-fling (issue #820's fix still
 *  holds), comfortably above a snap correction's own settle-out. */
const SCROLL_IDLE_MS = 150;

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

/** Explicit `behavior: 'smooth'` ignores CSS `scroll-behavior` (see nav.tsx) — so a
 *  JS-driven scroll has to check both motion sources itself, same as there. */
function prefersReducedMotion(): boolean {
  return (
    window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
    document.documentElement.getAttribute('data-reduce-motion') === 'true'
  );
}

/** Monday-first weekday index (0 = Mo … 6 = So) for a single day key, used by
 *  the week-view's continuous track (month view already has this for free —
 *  it renders one whole Mon–Sun row at a time). */
function weekdayIndexOf(day: string): number {
  return (parseDateKey(day).getUTCDay() + 6) % 7;
}

/** One pixel step per unit — a day-cell's width in week view, a week-row's
 *  height in month view. Measured off one actual rendered cell/row rather
 *  than dividing the track's own box by `VISIBLE_DAYS`/`VISIBLE_WEEKS`: the
 *  track's `height` transitions on the Woche/Monat switch
 *  (calendar-strip.css), so right after that toggle `track.clientHeight` can
 *  still read the *pre*-transition value while `useLayoutEffect` below sets
 *  the scroll target from it — a wrong step there lands `leadIndex` on the
 *  wrong day/week once the scroll handler re-measures against the settled
 *  height. A cell's/row's own size never transitions, only the track's does. */
function stepFor(track: HTMLElement, expanded: boolean): number {
  const sample = track.querySelector<HTMLElement>(
    expanded ? '.calendar-strip__week-row' : '.calendar-strip__cell',
  );
  if (sample) {
    const rect = sample.getBoundingClientRect();
    return expanded ? rect.height : rect.width;
  }
  return expanded ? track.clientHeight / VISIBLE_WEEKS : track.clientWidth / VISIBLE_DAYS;
}

interface CalendarDayCellProps {
  day: string;
  selected: boolean;
  interactive: boolean;
  isToday: boolean;
  weekdayLabel: string;
  dayNumber: number;
  dots: EventView['category'][];
  onSelect: (day: string) => void;
}

/** One day button in week view, split out of the carousel's `.map` (issue
 *  #824) so a `leadIndex` change during scroll — which only moves the
 *  interactive band, not any cell's own data — re-renders just the ~7–14
 *  cells crossing that band instead of all `RADIUS_DAYS * 2 + 1` of them. */
const CalendarDayCell = memo(function CalendarDayCell({
  day,
  selected,
  interactive,
  isToday,
  weekdayLabel,
  dayNumber,
  dots,
  onSelect,
}: CalendarDayCellProps) {
  return (
    <li className="calendar-strip__cell">
      <button
        type="button"
        className={
          selected ? 'calendar-strip__day calendar-strip__day--selected' : 'calendar-strip__day'
        }
        data-today={isToday ? '' : undefined}
        inert={!interactive}
        aria-hidden={interactive ? undefined : true}
        aria-pressed={selected}
        aria-label={`${weekdayLabel}, ${dayNumber}.`}
        onClick={() => onSelect(day)}
      >
        <span className="calendar-strip__weekday" aria-hidden="true">
          {weekdayLabel}
        </span>
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
});

interface CalendarWeekRowProps {
  week: string[];
  selectedDay: string;
  today: string;
  rowInteractive: boolean;
  focusMonth: string;
  dotsByDay: Map<string, EventView['category'][]>;
  onSelect: (day: string) => void;
}

/** One week row in month view, split out of the carousel's `.map` (issue
 *  #824) — invalidates only when the *focused month* changes (~every 4–5
 *  rows scrolled) rather than on every `leadIndex` step, since `focusMonth`
 *  is the only per-scroll input this row's rendering depends on. */
const CalendarWeekRow = memo(function CalendarWeekRow({
  week,
  selectedDay,
  today,
  rowInteractive,
  focusMonth,
  dotsByDay,
  onSelect,
}: CalendarWeekRowProps) {
  return (
    <li className="calendar-strip__week-row">
      <ul className="calendar-strip__days">
        {week.map((day, dayIndex) => {
          const isSelected = day === selectedDay;
          const isOutsideMonth = day.slice(0, 7) !== focusMonth;
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
                inert={!rowInteractive}
                aria-hidden={rowInteractive ? undefined : true}
                aria-pressed={isSelected}
                aria-label={`${WEEKDAY_LABELS[dayIndex]}, ${dayNumber}.`}
                onClick={() => onSelect(day)}
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
    </li>
  );
});

/**
 * Week strip that pulls open into a full month (issue #556, S5 of #473 — a
 * fixed Mon–Sun strip in S2/#553, then called "week-strip").
 *
 * A continuously rolling strip (issue #813, replaces #805's 3-page scroll-snap
 * carousel, which could only ever swipe a whole week/month at a time — the
 * "snap to a full unit" jump this ticket removes): a generously buffered
 * window of real days (`dayWindow`) or real Mon–Sun weeks (`weekWindow`)
 * around `windowAnchor`, rendered all at once so a swipe is native scrolling
 * the whole way, never a hand-picked jump. `windowAnchor` only moves — and
 * only silently, compensating the scroll position in the same layout pass —
 * once scrolling settles (`scrollend`) with the visible band within
 * `MARGIN_DAYS`/`MARGIN_WEEKS` of the buffer's edge — never mid-gesture, or
 * the reset itself cancels the native fling still in flight (issue #820);
 * the rest of the time the buffer just sits there while `leadIndex` (the
 * first visible cell/row) tracks the live scroll position on every `scroll`.
 * Week view rolls horizontally, day by day; month view rolls vertically,
 * week by week — the axis switch (and the vertical direction: up = later,
 * down = earlier) is this ticket's second half.
 *
 * `anchorDay` (issue #784) is a second, purely local state: it drives what
 * the grid/title show, `selectedDay` (the prop) drives only `aria-pressed`
 * and — one level up in calendar-view.tsx — the agenda below. Rolling moves
 * only the window; tapping a day, the day-step arrows and "Heute" move both
 * (`selectDay` below), jumping straight there with no animation, however far
 * the target is — the desktop `‹`/`›` buttons (`pageBy`) are the one
 * exception, gliding smoothly to the neighbour week/month.
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
  const [windowAnchor, setWindowAnchor] = useState(selectedDay);
  const [leadIndex, setLeadIndex] = useState(() => (expanded ? RADIUS_WEEKS : RADIUS_DAYS));
  const [jumpToken, setJumpToken] = useState(0);
  const trackRef = useRef<HTMLUListElement>(null);
  /** Sub-cell scroll offset a silent rebuild carries over so the visual
   *  position never jumps — set by the scroll handler right before it calls
   *  `setWindowAnchor`, consumed once by the layout effect below. An explicit
   *  jump (tap/"Heute"/arrows/Woche-Monat) leaves it at 0: the target lands
   *  exactly as the leading cell. */
  const pendingFracRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const windowDays = useMemo(() => dayWindow(windowAnchor, RADIUS_DAYS), [windowAnchor]);
  const windowWeeks = useMemo(() => weekWindow(windowAnchor, RADIUS_WEEKS), [windowAnchor]);

  const leadDay = (expanded ? windowWeeks[leadIndex]?.[0] : windowDays[leadIndex]) ?? windowAnchor;

  const visibleDays = useMemo(
    () =>
      expanded
        ? windowWeeks.slice(leadIndex, leadIndex + VISIBLE_WEEKS).flat()
        : windowDays.slice(leadIndex, leadIndex + VISIBLE_DAYS),
    [expanded, windowDays, windowWeeks, leadIndex],
  );

  /**
   * One `expandForDay` pass per day across the whole buffer — the same call
   * the timeline makes for the selected day, so the dots agree with it by
   * construction instead of by a second, parallel rule (issue #612).
   */
  const dotsByDay = useMemo(() => {
    const days = expanded ? windowWeeks.flat() : windowDays;
    return new Map(days.map((day) => [day, categoriesForDay(expandForDay(events, exceptions, day), day)]));
  }, [expanded, windowDays, windowWeeks, events, exceptions]);

  // "Heute" is inactive only once both states already agree with today —
  // otherwise the chip stays the only way back (issue #784, AK6).
  const todayVisible = visibleDays.includes(today);
  const todayInactive = selectedDay === today && todayVisible;

  /** Places `windowAnchor` as the leading cell/row, instantly — runs after
   *  every buffer rebuild (silent re-anchor near the edge, or an explicit
   *  jump/Woche-Monat switch), always before paint so neither is visible
   *  (issue #813, the seamless recentre-with-compensation trick). */
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const step = stepFor(track, expanded);
    const radius = expanded ? RADIUS_WEEKS : RADIUS_DAYS;
    const target = radius * step + pendingFracRef.current;
    pendingFracRef.current = 0;
    if (expanded) track.scrollTop = target;
    else track.scrollLeft = target;
    setLeadIndex(radius);
  }, [windowAnchor, expanded, jumpToken]);

  /** Tracks the live scroll position: `leadIndex` (drives the title, the
   *  dimming and the interactive band) updates every frame, on the `scroll`
   *  event. The buffer itself only ever rebuilds once scrolling has fully
   *  settled — never mid-gesture (issue #820). Resetting `scrollLeft`/
   *  `scrollTop` from inside a `scroll` handler cancels the browser's own
   *  fling outright (setting a scroll offset from script stops native
   *  momentum dead), and if that reset lands mid rubber-band bounce the read
   *  `pos` can sit outside the buffer's range entirely — either way the
   *  *next* touch-move has to resync with a finger that kept moving, which is
   *  the sudden extra-fast jump this ticket reports right where the buffer
   *  re-anchors. Once scrolling has actually stopped there's no ongoing
   *  motion left to cancel, so the same reset is invisible.
   *
   *  "Settled" is `SCROLL_IDLE_MS` of no further `scroll` events, not the
   *  native `scrollend` event (issue #822) — that event is the fast path
   *  when it fires, but it isn't the only trigger: on engines where it goes
   *  missing (see `SCROLL_IDLE_MS`'s comment), the idle timer is the one
   *  that actually rebuilds the buffer, so scrolling never gets stuck at the
   *  edge of the initial window. Both funnel into the same idempotent
   *  `handleScrollEnd` — whichever fires first wins, the other is a no-op
   *  (`newAnchor === windowAnchor` by then). */
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    function readClamp(current: HTMLElement) {
      const step = stepFor(current, expanded);
      if (step <= 0) return null;
      const visibleCount = expanded ? VISIBLE_WEEKS : VISIBLE_DAYS;
      const length = expanded ? windowWeeks.length : windowDays.length;
      const pos = expanded ? current.scrollTop : current.scrollLeft;
      const rawIndex = Math.floor(pos / step);
      const clamped = Math.min(Math.max(rawIndex, 0), length - visibleCount);
      return { step, length, visibleCount, pos, clamped };
    }

    function handleScrollEnd() {
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      const current = trackRef.current;
      if (!current) return;
      const result = readClamp(current);
      if (!result) return;
      const { step, length, visibleCount, pos, clamped } = result;
      const margin = expanded ? MARGIN_WEEKS : MARGIN_DAYS;
      if (clamped <= margin || clamped + visibleCount >= length - margin) {
        const newAnchor = expanded ? windowWeeks[clamped]?.[0] : windowDays[clamped];
        if (newAnchor && newAnchor !== windowAnchor) {
          pendingFracRef.current = pos - clamped * step;
          setWindowAnchor(newAnchor);
        }
      }
    }

    function handleScroll() {
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(handleScrollEnd, SCROLL_IDLE_MS);

      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const current = trackRef.current;
        if (!current) return;
        const result = readClamp(current);
        if (!result) return;
        setLeadIndex((prev) => (prev === result.clamped ? prev : result.clamped));
      });
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
      if (rafRef.current !== null) {
        // A silent rebuild's synchronous scrollLeft/scrollTop reset (the
        // layout effect above) fires its own `scroll` event, which this
        // very listener — still attached, about to be torn down — can pick
        // up and schedule a rAF for. Leaving the ref non-null after
        // cancelling that stale rAF would permanently trip `handleScroll`'s
        // `rafRef.current !== null` guard in the *next* effect instance,
        // freezing `leadIndex` (and `data-anchor-day`) against every scroll
        // from then on.
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [expanded, windowDays, windowWeeks, windowAnchor]);

  /** Sets selection *and* re-anchors the view on it — tap, day-step arrows and "Heute" all funnel through here (issue #784, AK4/AK6/AK7). Jumps straight there, no animation, however far the target is.
   *  `useCallback` so it's a stable prop for `CalendarDayCell`/`CalendarWeekRow` (issue #824) — a new
   *  function identity every render would break their `memo` regardless of any other prop. */
  const selectDay = useCallback(
    (day: string) => {
      onSelectDay(day);
      pendingFracRef.current = 0;
      setJumpToken((token) => token + 1);
      setWindowAnchor(day);
    },
    [onSelectDay],
  );

  /**
   * Pages a week in week view, a month in month view — the desktop `‹`/`›`
   * buttons' own source (issue #630, AK9). Moves only the preview, leaving the
   * selection untouched (issue #784, AK7). Glides smoothly to a neighbour
   * that's already inside the current buffer (`RADIUS_DAYS`/`RADIUS_WEEKS`
   * are sized generously enough for that) — the same scroll handler above
   * picks the glide up mid-flight and silently rebuilds once it needs to.
   */
  function pageBy(delta: 1 | -1) {
    const track = trackRef.current;
    if (!track) return;
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    const step = stepFor(track, expanded);
    if (expanded) {
      const targetWeekStart = weekDaysFor(addMonthsClamped(leadDay, delta))[0];
      const rowDelta = dateKeyDiff(leadDay, targetWeekStart) / 7;
      track.scrollTo({ top: track.scrollTop + rowDelta * step, behavior });
    } else {
      track.scrollTo({ left: track.scrollLeft + delta * 7 * step, behavior });
    }
  }

  return (
    <div className="calendar-strip" data-expanded={expanded} data-anchor-day={leadDay}>
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
        <p className="calendar-strip__title">{formatMonthTitle(leadDay)}</p>
        <SegmentedControl
          options={VIEW_OPTIONS}
          value={expanded ? 'monat' : 'woche'}
          onChange={(next) => {
            pendingFracRef.current = 0;
            onExpandChange(next === 'monat');
          }}
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
      {expanded && (
        <ul className="calendar-strip__weekday-header" aria-hidden="true">
          {WEEKDAY_LABELS.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      )}
      <ul className="calendar-strip__carousel" ref={trackRef} data-expanded={expanded}>
        {!expanded &&
          windowDays.map((day, index) => (
            <CalendarDayCell
              key={day}
              day={day}
              selected={day === selectedDay}
              interactive={index >= leadIndex && index < leadIndex + VISIBLE_DAYS}
              isToday={day === today}
              weekdayLabel={WEEKDAY_LABELS[weekdayIndexOf(day)]}
              dayNumber={Number(day.slice(-2))}
              dots={dotsByDay.get(day) ?? []}
              onSelect={selectDay}
            />
          ))}
        {expanded &&
          windowWeeks.map((week, rowIndex) => (
            <CalendarWeekRow
              key={week[0]}
              week={week}
              selectedDay={selectedDay}
              today={today}
              rowInteractive={rowIndex >= leadIndex && rowIndex < leadIndex + VISIBLE_WEEKS}
              focusMonth={leadDay.slice(0, 7)}
              dotsByDay={dotsByDay}
              onSelect={selectDay}
            />
          ))}
      </ul>
    </div>
  );
}
