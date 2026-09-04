'use client';

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  allDayBandsForWindow,
  categoriesForDay,
  categoryEdgeVar,
  weekDaysFor,
  weekWindow,
  type AllDayBand,
} from './event-time';
import { expandForDay } from './recurrence';
import type { EventExceptionView } from './use-event-exceptions';
import type { EventView } from './use-events';

const WEEKDAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Dot cap for the card — tighter than the week strip's 4 (`categoriesForDay`'s
 *  default), the card's cells are narrower (issue #958, AK3). */
const MAX_DOTS_IN_GRID = 3;

/** Band cap per week row — tighter than the week strip's 3 (issue #1043,
 *  AK8): a week row shares its width with six others stacked in the same
 *  card, so two is what stays legible. */
const MAX_BANDS_IN_GRID = 2;

/** One screen's worth of week rows — `.month-grid__track`'s CSS height is
 *  built from the same number (month-grid.css), so the interactive band below
 *  and the visible band agree by construction. */
const VISIBLE_WEEKS = 6;

/** Buffer radius either side of the anchor week — a year each way, the same
 *  reasoning `calendar-strip.tsx` carries for days (issue #824): far enough
 *  that ordinary scrolling never reaches the edge, so the silent re-anchor
 *  stays a safety net rather than something normal use runs into. */
const RADIUS_WEEKS = 52;

/** How close to a buffer edge (in week rows) triggers a silent re-anchor —
 *  see the `useLayoutEffect` below for the scroll-position compensation that
 *  makes it invisible. */
const MARGIN_WEEKS = 8;

/** No further `scroll` events for this long counts as "settled" — the same
 *  hand-rolled `scrollend` fallback `calendar-strip.tsx` carries (issue #822:
 *  the native event is known to go missing on some engines). Only the buffer
 *  re-anchor waits for it; the focused month follows every frame (issue
 *  #1064), so nothing the eye can see is gated on this timer any more. */
const SCROLL_IDLE_MS = 150;

export interface MonthGridProps {
  /** `YYYY-MM` — the month the header names. Owned by calendar-view.tsx, fed
   *  back from here whenever scrolling brings a different month into the
   *  middle of the card. */
  focusMonth: string;
  selectedDay: string;
  today: string;
  events: EventView[];
  exceptions: EventExceptionView[];
  onSelectDay: (dateKey: string) => void;
  onFocusMonth: (focusMonth: string) => void;
}

interface WeekLayout {
  /** Monday-first date keys of this week — `weekDays[0]` is also its React key. */
  weekDays: string[];
  bands: AllDayBand[];
  /** 0 with no all-day event that week (issue #1043, AK9 — no reserved empty
   *  row); 2 only when two bands genuinely overlap in column range (AK8: two
   *  bands sharing no day share a single row), else 1. */
  bandRows: 0 | 1 | 2;
  /** Category dots per day of this week, `MAX_DOTS_IN_GRID` at most. */
  dots: EventView['category'][][];
}

/**
 * One `expandForDay` pass per day of the buffer, shared between the dots and
 * the all-day bands — the same call the timeline makes for the selected day,
 * so all three agree by construction (issue #612). Ordered like `weeks`.
 */
function layoutForWeeks(
  weeks: string[][],
  events: EventView[],
  exceptions: EventExceptionView[],
): WeekLayout[] {
  return weeks.map((weekDays) => {
    const occurrences = new Map(
      weekDays.map((day) => [day, expandForDay(events, exceptions, day)]),
    );
    const bands = allDayBandsForWindow(
      weekDays,
      (day) => occurrences.get(day) ?? [],
      MAX_BANDS_IN_GRID,
    );
    const overlaps = bands.length > 1 && bands[0].endCol >= bands[1].startCol;
    return {
      weekDays,
      bands,
      bandRows: bands.length === 0 ? 0 : overlaps ? 2 : 1,
      dots: weekDays.map((day) =>
        categoriesForDay(occurrences.get(day) ?? [], day, MAX_DOTS_IN_GRID),
      ),
    } satisfies WeekLayout;
  });
}

/** Bitmask of this week's days that fall outside `focusMonth` — a plain
 *  number so `MonthWeekRow`'s `memo` re-renders only the handful of rows
 *  whose dimming actually flips when the focused month moves, not all
 *  `RADIUS_WEEKS * 2 + 1` of them (issue #1064; the same per-row memoisation
 *  reasoning `calendar-strip.tsx` applies per cell). */
function dimMaskFor(weekDays: string[], focusMonth: string): number {
  let mask = 0;
  weekDays.forEach((day, col) => {
    if (day.slice(0, 7) !== focusMonth) mask |= 1 << col;
  });
  return mask;
}

/** The month a week belongs to — its Thursday's, the ISO rule, so a week
 *  split across a month boundary counts once, for the month holding most of
 *  it. */
function monthOfWeek(weekDays: string[]): string {
  return weekDays[3].slice(0, 7);
}

/** The month the header names for a given scroll position: the one owning the
 *  week in the middle of the visible band. Symmetric in both directions — the
 *  title flips exactly when a month boundary crosses the middle of the card,
 *  never mid-row (issue #1064). */
function focusMonthForLead(weeks: string[][], leadIndex: number): string {
  const middle = Math.min(leadIndex + Math.floor(VISIBLE_WEEKS / 2), weeks.length - 1);
  return monthOfWeek(weeks[middle]);
}

interface MonthWeekRowProps {
  layout: WeekLayout;
  /** Inside the visible band — only these rows are focusable and tappable,
   *  the buffer around them is `inert` + `aria-hidden`. Without it the
   *  buffer's ~100 rows would repeat every `aria-label` ("Mo, 3.") many times
   *  over, for screen readers and for any locator keyed off one alike — the
   *  recipe `calendar-strip.tsx` uses for its own day buffer. */
  interactive: boolean;
  /** Column of the selected day in this week, `-1` when it is not in it — a
   *  number rather than the day key itself, so selecting a day re-renders the
   *  two rows that actually change instead of the whole buffer. `todayCol`
   *  likewise. */
  selectedCol: number;
  todayCol: number;
  dimMask: number;
  onSelect: (day: string) => void;
}

/** One Mon–Sun row of the continuous track: seven day cells in row 1, this
 *  week's all-day bands in the row(s) under them (issue #1043's shape, now
 *  per week rather than per month page). */
const MonthWeekRow = memo(function MonthWeekRow({
  layout,
  interactive,
  selectedCol,
  todayCol,
  dimMask,
  onSelect,
}: MonthWeekRowProps) {
  const { weekDays, bands, bandRows, dots } = layout;
  return (
    <div
      className="month-grid__week"
      data-week={weekDays[0]}
      inert={!interactive}
      aria-hidden={interactive ? undefined : true}
    >
      <ul className="month-grid__days">
        {weekDays.map((day, col) => {
          const dayNumber = Number(day.slice(-2));
          const isSelected = col === selectedCol;
          return (
            <li key={day} style={{ gridRow: 1, gridColumn: col + 1 } as CSSProperties}>
              <button
                type="button"
                className={
                  isSelected ? 'month-grid__day month-grid__day--selected' : 'month-grid__day'
                }
                data-today={col === todayCol ? '' : undefined}
                data-outside-month={(dimMask >> col) & 1 ? '' : undefined}
                aria-pressed={isSelected}
                aria-label={`${WEEKDAY_LABELS[col]}, ${dayNumber}.`}
                onClick={() => onSelect(day)}
              >
                <span aria-hidden="true">{dayNumber}</span>
                <span className="month-grid__dots" aria-hidden="true">
                  {dots[col].map((category) => (
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
        {bands.map((band, index) => (
          <li
            key={band.id}
            className="month-grid__band"
            aria-hidden="true"
            data-continues-before={band.continuesBefore ? '' : undefined}
            data-continues-after={band.continuesAfter ? '' : undefined}
            style={
              {
                gridRow: bandRows === 2 && index === 1 ? 3 : 2,
                gridColumn: `${band.startCol + 1} / ${band.endCol + 2}`,
                '--band-cat': categoryEdgeVar(band.category),
              } as CSSProperties
            }
          >
            <span className="month-grid__band-title">{band.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});

/**
 * Month card in `/kalender`'s body (issue #958, T1 of #957; wiped free of its
 * nav buttons and made swipeable in issue #1009; swipe axis turned vertical
 * in issue #1039) — the month view's only calendar surface;
 * `calendar-strip.tsx` stays a pure week strip.
 *
 * Since issue #1064 it scrolls freely instead of paging: one continuous
 * vertical track of Mon–Sun week rows with a year's buffer either side of the
 * anchor week, no scroll snapping, and no settle-then-load step anywhere in
 * the visible path. That replaces the three-page snap carousel #1009/#1039
 * built, where every gesture landed on a whole month page and the next page
 * only followed after `SCROLL_IDLE_MS` of stillness — the two things the
 * ticket reports as "springt" and "warten, bis der nächste Monat geladen
 * ist". The buffer still re-anchors silently near its edge (the same
 * compensate-before-paint trick as `calendar-strip.tsx`), but a year of rows
 * means ordinary scrolling never reaches one.
 *
 * Every calendar week is rendered exactly once, so no day appears twice — the
 * neighbour-month repetition the page carousel needed is gone. Days outside
 * the focused month stay dimmed (issue #958, AK2): inside one uninterrupted
 * grid, that dimming is what marks the month boundaries.
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
  const rafRef = useRef<number | null>(null);
  /** Every week row's offset inside the track, re-measured after each layout
   *  pass — week rows are not uniformly tall (a week carrying all-day events
   *  gets one or two extra rows, issue #1043 AK9), so the scroll maths reads
   *  real geometry instead of multiplying a fixed step the way the week strip
   *  can. */
  const offsetsRef = useRef<number[]>([]);
  /** Sub-row remainder carried across a silent re-anchor, so the compensating
   *  scroll lands on the exact pixel the gesture ended on, not on a row edge. */
  const pendingFracRef = useRef(0);

  /** The week the buffer is centred on — moved only by the silent re-anchor
   *  near an edge, never by ordinary scrolling. */
  const [windowAnchor, setWindowAnchor] = useState(() => weekDaysFor(`${focusMonth}-01`)[0]);
  const [leadIndex, setLeadIndex] = useState(RADIUS_WEEKS);

  const weeks = useMemo(() => weekWindow(windowAnchor, RADIUS_WEEKS), [windowAnchor]);
  const layouts = useMemo(
    () => layoutForWeeks(weeks, events, exceptions),
    [weeks, events, exceptions],
  );

  const handleSelect = useCallback(
    (day: string) => {
      onSelectDay(day);
      // Tapping a dimmed neighbour-month day moves the header onto that month
      // (issue #958) — the track itself stays exactly where it is (issue
      // #1009, AK3); only the dimming and the title follow.
      onFocusMonth(day.slice(0, 7));
    },
    [onSelectDay, onFocusMonth],
  );

  /** Re-measures every row's offset — after a buffer rebuild, and after any
   *  event change that can add or drop a band row. */
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const rows = track.querySelectorAll<HTMLElement>('.month-grid__week');
    offsetsRef.current = Array.from(rows, (row) => row.offsetTop);
  }, [layouts]);

  /** Puts the anchor week at the top of the card, instantly and before paint —
   *  on mount (the focused month's first week) and after every silent
   *  re-anchor, where `pendingFracRef` carries the gesture's sub-row remainder
   *  so the correction is invisible. Deliberately *not* keyed on `focusMonth`:
   *  that prop follows this card's own scrolling, and resetting the scroll
   *  position from it is exactly the jump-back-to-the-middle issue #1064
   *  removes. */
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollTop = (offsetsRef.current[RADIUS_WEEKS] ?? 0) + pendingFracRef.current;
    pendingFracRef.current = 0;
    setLeadIndex(RADIUS_WEEKS);
  }, [windowAnchor]);

  /** Reports the month in the middle of the card up. Driven by `leadIndex`,
   *  which the scroll handler updates every frame — so the header follows the
   *  finger instead of waiting for the scroll to settle (issue #1064). */
  useEffect(() => {
    const next = focusMonthForLead(weeks, leadIndex);
    if (next !== focusMonth) onFocusMonth(next);
  }, [weeks, leadIndex, focusMonth, onFocusMonth]);

  /** Tracks the live scroll position: `leadIndex` (title, dimming, the
   *  interactive band) updates every frame on `scroll`. The buffer itself
   *  only rebuilds once scrolling has fully settled *and* only near an edge —
   *  resetting `scrollTop` mid-gesture cancels the browser's own momentum
   *  outright (issue #820). "Settled" is `SCROLL_IDLE_MS` of quiet or a
   *  native `scrollend`, whichever comes first (issue #822); both funnel into
   *  the same idempotent handler. */
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;

    /** Index of the topmost row at or above `pos` — a binary search over the
     *  measured offsets, since rows differ in height. The 1px pad absorbs the
     *  sub-pixel rounding a fractional `scrollTop` write leaves behind (the
     *  same rounding `calendar-strip.tsx` pads for). */
    function leadIndexAt(pos: number): number | null {
      const offsets = offsetsRef.current;
      if (offsets.length === 0) return null;
      let low = 0;
      let high = offsets.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (offsets[mid] <= pos + 1) low = mid;
        else high = mid - 1;
      }
      return Math.min(low, Math.max(offsets.length - VISIBLE_WEEKS, 0));
    }

    function handleScrollEnd() {
      if (idleTimerRef.current !== null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      const current = trackRef.current;
      if (!current) return;
      const pos = current.scrollTop;
      const index = leadIndexAt(pos);
      if (index === null) return;
      if (index > MARGIN_WEEKS && index + VISIBLE_WEEKS < weeks.length - MARGIN_WEEKS) return;
      const newAnchor = weeks[index]?.[0];
      if (!newAnchor || newAnchor === windowAnchor) return;
      pendingFracRef.current = pos - (offsetsRef.current[index] ?? pos);
      setWindowAnchor(newAnchor);
    }

    function handleScroll() {
      if (idleTimerRef.current !== null) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(handleScrollEnd, SCROLL_IDLE_MS);

      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const current = trackRef.current;
        if (!current) return;
        const index = leadIndexAt(current.scrollTop);
        if (index === null) return;
        setLeadIndex((prev) => (prev === index ? prev : index));
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
        // The re-anchor's own synchronous `scrollTop` write fires a `scroll`
        // event this listener can still pick up while being torn down;
        // leaving the ref non-null would freeze `leadIndex` in the next
        // effect instance — the trap `calendar-strip.tsx` documents.
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [weeks, windowAnchor]);

  return (
    <div className="month-grid" data-focus-month={focusMonth} data-lead-week={weeks[leadIndex]?.[0]}>
      <ul className="month-grid__weekday-header" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
      <div className="month-grid__track" ref={trackRef}>
        {layouts.map((layout, index) => (
          <MonthWeekRow
            key={layout.weekDays[0]}
            layout={layout}
            interactive={index >= leadIndex && index < leadIndex + VISIBLE_WEEKS}
            selectedCol={layout.weekDays.indexOf(selectedDay)}
            todayCol={layout.weekDays.indexOf(today)}
            dimMask={dimMaskFor(layout.weekDays, focusMonth)}
            onSelect={handleSelect}
          />
        ))}
      </div>
    </div>
  );
}
