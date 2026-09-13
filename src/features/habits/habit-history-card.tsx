'use client';

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useHabitHistoryRange, type HabitHistoryRangeDays } from '../settings/use-habit-history-range';
import { toDateKey } from './due-today';
import {
  historyAxis,
  historyGrid,
  historyRangeLabel,
  isHabitDoneOnDay,
  visibleDoneCount,
  type HistoryGridDay,
} from './history-grid';
import { useHabitLogs } from './use-habit-logs';
import { compareHabits, useHabits, type HabitView } from './use-habits';

/** Cell width per period at the 375px reference layout (issue #1184's
 *  measurement table, 311px card inner width) — fixed per period, not fluid
 *  like the old `minmax(0, 14px)` track: a fixed pixel size is what lets the
 *  grid grow wider than its scroll container (F2) and lets `dayCenterOffsets`
 *  below stay purely arithmetic instead of a DOM measurement (F4). */
const HISTORY_CELL_PX: Record<HabitHistoryRangeDays, number> = {
  30: 10.1,
  28: 10.8,
  21: 14.5,
  14: 21.9,
  7: 44.1,
};

/** True when `dateKey` (`YYYY-MM-DD`) falls on a Monday, parsed as a local date to avoid UTC off-by-one. */
function isMonday(dateKey: string): boolean {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day).getDay() === 1;
}

/**
 * Grid column tracks for the day cells plus a 2px track before every Monday
 * in the window (except the first day, even if it is itself a Monday — a gap
 * before the first column would just be dead space). `dayColumns[i]` and
 * `weekLineColumns[i]` are 1-based CSS grid line numbers. `dayCenters[i]` is
 * day `i`'s horizontal pixel center, cumulative from the track's own start —
 * the sole input the visible-window scroll math (below) needs, so it never
 * measures the DOM (issue #1184 F4).
 */
function weekLayout(
  days: HistoryGridDay[],
  cellPx: number,
): {
  gridTemplateColumns: string;
  dayColumns: number[];
  weekLineColumns: number[];
  dayCenters: number[];
} {
  const WEEK_LINE_PX = 2;
  const tracks: string[] = [];
  const dayColumns: number[] = [];
  const weekLineColumns: number[] = [];
  const dayCenters: number[] = [];
  let cursor = 0;

  days.forEach((day, index) => {
    if (index > 0 && isMonday(day.dateKey)) {
      tracks.push(`${WEEK_LINE_PX}px`);
      weekLineColumns.push(tracks.length);
      cursor += WEEK_LINE_PX;
    }
    tracks.push(`${cellPx}px`);
    dayColumns.push(tracks.length);
    dayCenters.push(cursor + cellPx / 2);
    cursor += cellPx;
  });

  return { gridTemplateColumns: tracks.join(' '), dayColumns, weekLineColumns, dayCenters };
}

/** First/last index whose day column's center sits inside `[scrollLeft, scrollLeft + clientWidth]`
 *  (issue #1184 AK5) — falls back to the last day if none matches (e.g. before first layout). */
function visibleWindowFor(
  scrollLeft: number,
  clientWidth: number,
  dayCenters: number[],
): [number, number] {
  const start = scrollLeft;
  const end = scrollLeft + clientWidth;
  let first = -1;
  let last = -1;
  dayCenters.forEach((center, index) => {
    if (center >= start && center <= end) {
      if (first === -1) first = index;
      last = index;
    }
  });
  if (first === -1) {
    const lastDay = dayCenters.length - 1;
    return [lastDay, lastDay];
  }
  return [first, last];
}

interface HistoryGridCellsProps {
  active: HabitView[];
  days: HistoryGridDay[];
  dayColumns: number[];
  weekLineColumns: number[];
}

/**
 * The grid's actual cells, split out of the card (issue #1184 F3) so a
 * scroll-driven change to the visible window — which only moves the head
 * count and axis labels, never a cell's own content — re-renders neither the
 * cells nor the week-line markers, however many thousand of them a long
 * history produces.
 */
const HistoryGridCells = memo(function HistoryGridCells({
  active,
  days,
  dayColumns,
  weekLineColumns,
}: HistoryGridCellsProps) {
  return (
    <>
      {weekLineColumns.map((column) => (
        <span
          key={`week-${column}`}
          className="habit-history-card__week-line"
          style={{ gridColumn: column, gridRow: '1 / -1' }}
        />
      ))}
      {active.map((habit, rowIndex) =>
        days.map((day, dayIndex) => {
          const done = isHabitDoneOnDay(day, habit.id);
          return (
            <span
              key={`${habit.id}-${day.dateKey}`}
              className="habit-history-card__cell"
              // The day column's snap point (issue #1184 AK1) — every day has a
              // row-0 cell (there is always at least one active habit here), so
              // marking just that row is enough to snap the whole column.
              data-day-start={rowIndex === 0 ? '' : undefined}
              style={{
                gridColumn: dayColumns[dayIndex],
                gridRow: rowIndex + 1,
                background: done ? (habit.emoji ? 'transparent' : 'var(--area-habits)') : undefined,
              }}
            >
              {done && habit.emoji ? (
                <span className="habit-history-card__emoji" aria-hidden="true">
                  {habit.emoji}
                </span>
              ) : null}
            </span>
          );
        }),
      )}
    </>
  );
});

/**
 * "Erledigt · 30 Tage" as a squares grid (issue #1070, replaces the step-chart
 * card from #905/#1040) — one column per day back to `historyLeftEdge`, one
 * fixed row per active habit in `compareHabits` order (oldest on top, same
 * order as the table above), a done habit's emoji on a transparent cell, or a
 * flat `--area-habits` fill for a habit with no emoji (issue #1150, replaces
 * the baseline-stacked, emoji-less grid from #1070/#1101 — fixed rows read
 * "which" habit, not just "how many"). A 2px column before every Monday
 * carries a hairline week divider. Renders nothing at 0 active habits, same
 * rule the card it replaces already followed (#905 AK7).
 *
 * Issue #1184 made the grid horizontally scrollable back to the oldest active
 * habit/log instead of a fixed 30-day window: everything from the left edge
 * to today renders at once (F3 — the data is bounded on both ends, unlike
 * `calendar-strip.tsx`'s open-ended buffer), a fixed per-day cell width (not
 * the old fluid `minmax(0, 14px)`) lets the grid grow past its container
 * (F2), and the card head/axis follow whichever days actually sit in the
 * scroll container's viewport (F4) rather than the whole window.
 */
export function HabitHistoryCard() {
  const habits = useHabits();
  const logs = useHabitLogs();
  const { windowDays } = useHabitHistoryRange();
  const cellPx = HISTORY_CELL_PX[windowDays];

  // A stable `now` for this mount, not a fresh `new Date()` every render —
  // otherwise every dependent `useMemo` below would recompute on every
  // scroll-driven re-render instead of only when the underlying data changes.
  const now = useMemo(() => new Date(), []);
  const todayKey = useMemo(() => toDateKey(now), [now]);

  const active = useMemo(
    () => (habits ?? []).filter((habit) => habit.archivedAt === null).sort(compareHabits),
    [habits],
  );

  const grid = useMemo(
    () => historyGrid(habits ?? [], logs ?? [], now, windowDays),
    [habits, logs, now, windowDays],
  );

  const { gridTemplateColumns, dayColumns, weekLineColumns, dayCenters } = useMemo(
    () => weekLayout(grid.days, cellPx),
    [grid.days, cellPx],
  );

  const trackRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<[number, number]>(() => [
    Math.max(0, grid.days.length - windowDays),
    grid.days.length - 1,
  ]);

  // Scrolls all the way right, instantly (issue #1184 AK2) — on mount, and
  // whenever the rendered day count or the cell width changes (a habit/log
  // loading in after this component's first paint, or the settings panel's
  // "Verlauf" range changing the period, issue #1184 AK10). Always before
  // paint (`useLayoutEffect`), same seamless-positioning trick
  // `calendar-strip.tsx` uses for its own silent re-anchor.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollLeft = track.scrollWidth - track.clientWidth;
    setVisible(visibleWindowFor(track.scrollLeft, track.clientWidth, dayCenters));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.days.length, cellPx]);

  // Tracks the live scroll position (issue #1184 AK5) — rAF-throttled like
  // `calendar-strip.tsx`'s own scroll handler, but with no buffer to
  // re-anchor: every day already renders (F3), so a plain `scroll` listener
  // is enough, no `scrollend`/idle-settle machinery is needed here.
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let rafId: number | null = null;

    function handleScroll() {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const current = trackRef.current;
        if (!current) return;
        const next = visibleWindowFor(current.scrollLeft, current.clientWidth, dayCenters);
        setVisible((prev) => (prev[0] === next[0] && prev[1] === next[1] ? prev : next));
      });
    }

    track.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      track.removeEventListener('scroll', handleScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [dayCenters]);

  if (habits === undefined || logs === undefined || active.length === 0) return null;

  // `visible`'s lazy initializer ran against whichever `windowDays` was live on
  // this component's very first render — `useSyncExternalStore` (issue #1184
  // Phase B) commits a second render right after with the real localStorage
  // value once it differs from `getServerSnapshot`'s 30-day default, shrinking
  // `grid.days` before the layout effect below gets a chance to re-anchor
  // `visible` to it. Clamping here is what keeps that one render from indexing
  // past the end of the new, shorter `days` array.
  const lastDayIndex = grid.days.length - 1;
  const [firstIndex, lastIndex] = visible;
  const safeFirstIndex = Math.min(firstIndex, lastDayIndex);
  const safeLastIndex = Math.min(lastIndex, lastDayIndex);
  const doneCount = visibleDoneCount(grid.days, safeFirstIndex, safeLastIndex);
  const axis = historyAxis({
    windowDays,
    days: grid.days,
    firstIndex: safeFirstIndex,
    lastIndex: safeLastIndex,
    today: todayKey,
    doneCount,
  });

  return (
    <div className="habit-history-card">
      <div className="habit-history-card__head">
        <p className="habit-history-card__label">Erledigt · {historyRangeLabel(windowDays)}</p>
        <p className="habit-history-card__value">{doneCount}</p>
      </div>
      <div className="habit-history-card__scroll" ref={trackRef}>
        <div
          className="habit-history-card__grid"
          style={
            {
              gridTemplateColumns,
              // Same fixed value on both axes (issue #1184 AK8) — squares the
              // cell without relying on `aspect-ratio` to reconcile a
              // definite column track against a content-sized row track.
              gridTemplateRows: `repeat(${active.length}, ${cellPx}px)`,
              // 0.75, not #1150's original 0.82 (issue #1184 AK8) — a color
              // emoji glyph's rendered width doesn't scale linearly with
              // `font-size` (the emoji font snaps to its own bitmap strikes),
              // so 0.82 left some of the five periods' cells with an emoji
              // 1-2px wider than the cell itself. 0.75 was checked against a
              // rendered probe at all five reference cell widths and clears
              // every one with margin to spare.
              '--history-emoji': `${cellPx * 0.75}px`,
            } as CSSProperties
          }
          role="img"
          aria-label={axis.ariaLabel}
        >
          <HistoryGridCells
            active={active}
            days={grid.days}
            dayColumns={dayColumns}
            weekLineColumns={weekLineColumns}
          />
        </div>
      </div>
      <div className="habit-history-card__axis">
        <span>{axis.leftLabel}</span>
        <span>{axis.rightLabel}</span>
      </div>
    </div>
  );
}
