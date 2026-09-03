'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react';
import {
  addDays,
  addMonthsClamped,
  allDayBandsForWindow,
  categoriesForDay,
  categoryEdgeVar,
  monthDaysFor,
  weekDaysFor,
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
 *  alignment — padded here to always 42 (six full Mon–Sun weeks) so every
 *  page keeps the same six day-rows; the card's overall height can still
 *  differ per page once all-day bands are involved (issue #1043, AK11). */
function gridDaysFor(focusMonth: string): string[] {
  const days = monthDaysFor(`${focusMonth}-01`);
  if (days.length === 42) return days;
  const extraWeek = weekDaysFor(addDays(days[days.length - 1], 1));
  return [...days, ...extraWeek];
}

interface MonthWeekLayout {
  weekDays: string[];
  bands: AllDayBand[];
  /** 0 with no all-day event that week (AK9, no reserved empty row); 2 only
   *  when two bands genuinely overlap in column range, else 1 (AK8: two
   *  bands sharing no day share a single row). */
  bandRows: 0 | 1 | 2;
}

/**
 * Every calendar week of a rendered page (six Mon–Sun rows, `gridDaysFor`'s
 * 42-cell padding), paired with the all-day bands due under it — at most
 * `MAX_BANDS_IN_GRID`, sorted/capped the same way `allDayBandsForWindow`
 * caps the week strip's own bands. Shared between `MonthPage`'s rendering
 * and `MonthGrid`'s track-height calculation (issue #1043) so both agree on
 * the same row count by construction, the same reasoning `dotsByDay`
 * elsewhere in this file already follows for dots.
 */
function monthWeekLayout(
  pageMonth: string,
  events: EventView[],
  exceptions: EventExceptionView[],
): MonthWeekLayout[] {
  const days = gridDaysFor(pageMonth);
  const weeks: string[][] = [];
  for (let start = 0; start < days.length; start += 7) {
    weeks.push(days.slice(start, start + 7));
  }
  return weeks.map((weekDays) => {
    const bands = allDayBandsForWindow(
      weekDays,
      (day) => expandForDay(events, exceptions, day),
      MAX_BANDS_IN_GRID,
    );
    const overlaps = bands.length > 1 && bands[0].endCol >= bands[1].startCol;
    const bandRows: MonthWeekLayout['bandRows'] = bands.length === 0 ? 0 : overlaps ? 2 : 1;
    return { weekDays, bands, bandRows };
  });
}

function totalBandRows(layout: MonthWeekLayout[]): number {
  return layout.reduce((sum, week) => sum + week.bandRows, 0);
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
  const weekLayout = useMemo(
    () => monthWeekLayout(pageMonth, events, exceptions),
    [pageMonth, events, exceptions],
  );
  const days = useMemo(() => weekLayout.flatMap((week) => week.weekDays), [weekLayout]);

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

  /** Day cells with an explicit `row`/`col` (issue #1043) — the band rows
   *  interspersed between weeks (below) would otherwise push later weeks'
   *  cells out of place under CSS Grid's auto-placement. */
  const dayCells = useMemo(() => {
    const cells: { day: string; row: number; col: number }[] = [];
    let row = 1;
    for (const week of weekLayout) {
      week.weekDays.forEach((day, col) => cells.push({ day, row, col }));
      row += 1 + week.bandRows;
    }
    return cells;
  }, [weekLayout]);

  /** Band cells, placed one row under their own week's day row — two rows
   *  only when that week's (at most `MAX_BANDS_IN_GRID`) bands genuinely
   *  overlap in column range (AK8). */
  const bandCells = useMemo(() => {
    const cells: { band: AllDayBand; row: number }[] = [];
    let row = 1;
    for (const week of weekLayout) {
      row += 1;
      week.bands.forEach((band, index) => {
        cells.push({ band, row: week.bandRows === 2 && index === 1 ? row + 1 : row });
      });
      row += week.bandRows;
    }
    return cells;
  }, [weekLayout]);

  return (
    <div className="month-grid__page" inert={!interactive} aria-hidden={interactive ? undefined : true}>
      <ul className="month-grid__days">
        {dayCells.map(({ day, row, col }) => {
          const dayNumber = Number(day.slice(-2));
          const isSelected = day === selectedDay;
          const isOutsideMonth = day.slice(0, 7) !== pageMonth;
          return (
            <li key={day} style={{ gridRow: row, gridColumn: col + 1 } as CSSProperties}>
              <button
                type="button"
                className={
                  isSelected ? 'month-grid__day month-grid__day--selected' : 'month-grid__day'
                }
                data-today={day === today ? '' : undefined}
                data-outside-month={isOutsideMonth ? '' : undefined}
                aria-pressed={isSelected}
                aria-label={`${WEEKDAY_LABELS[col]}, ${dayNumber}.`}
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
        {bandCells.map(({ band, row }) => (
          <li
            key={band.id}
            className="month-grid__band"
            aria-hidden="true"
            data-continues-before={band.continuesBefore ? '' : undefined}
            data-continues-after={band.continuesAfter ? '' : undefined}
            style={
              {
                gridRow: row,
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
}

/**
 * Month card in `/kalender`'s body (issue #958, T1 of #957; wiped free of its
 * nav buttons and made swipeable in issue #1009; swipe axis turned vertical
 * in issue #1039 — a month rolls like a page, it doesn't page sideways like
 * the day-oriented week strip) — the month view's only calendar surface;
 * `calendar-strip.tsx` stays a pure week strip. Three whole months
 * (prev/current/next) sit in a vertical `scroll-snap-type: y mandatory`
 * track; a swipe snaps to a neighbour page, which is reported up via
 * `onFocusMonth` once it settles, and the track silently recentres on the
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

  /** All-day band rows the focused page needs (issue #1043, AK11) — drives
   *  `.month-grid__track`'s CSS height (`--month-grid-band-rows`) in the same
   *  render pass the layout effect below resets `scrollTop` in, so by the
   *  time a swipe settles on a neighbour month the track's height already
   *  matches it. */
  const bandRowCount = useMemo(
    () => totalBandRows(monthWeekLayout(focusMonth, events, exceptions)),
    [focusMonth, events, exceptions],
  );

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
    track.scrollTop = track.clientHeight;
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
      const pageHeight = current.clientHeight;
      if (pageHeight <= 0) return;
      const page = Math.round(current.scrollTop / pageHeight);
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
    <div
      className="month-grid"
      data-focus-month={focusMonth}
      style={{ '--month-grid-band-rows': bandRowCount } as CSSProperties}
    >
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
