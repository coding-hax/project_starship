/**
 * Pure agenda/calendar-day logic (issue #553, S2 of #473; agenda issue #597;
 * all-day band issue #555, S4; overview countdown issue #559, S8) — no DB, no
 * DOM, so it's Vitest-testable like habits/due-today.ts and schedule-rules.ts.
 */

import { berlinNow } from '@/push/schedule';
import type { EventView } from './use-events';

/** Berlin-local minutes since midnight for an ISO instant — thin wrapper, no new TZ logic. */
export function berlinMinutesOfDay(instant: string): number {
  return berlinNow(new Date(instant)).minutesOfDay;
}

function berlinDateKey(instant: string): string {
  return berlinNow(new Date(instant)).dateKey;
}

/**
 * What `layoutForDay`/`allDayEventsForDay` need from a rendered item — the
 * shape both `EventView` (a plain event) and `Occurrence` (a series instance,
 * recurrence.ts) satisfy, so the layout functions work on either without this
 * file importing recurrence.ts (which itself imports from here — see its doc
 * comment).
 */
export interface TimelineSource {
  id: string;
  title: string;
  allDay: boolean;
  startsAt: string | null;
  endsAt: string | null;
  startDate: string | null;
  endDate: string | null;
  category: EventView['category'];
}

/**
 * Scheduled events on `dayKey` (a Berlin calendar day, `YYYY-MM-DD`), chronological
 * (issue #597 — replaces the hour-axis `layoutForDay`). All-day events and events
 * with no `startsAt`/`endsAt` are filtered out, same touch rule as before: an event
 * starting before `dayKey` or ending after it still shows (its instant is just
 * outside the day, the agenda has no axis to clamp it to).
 */
export function agendaForDay<T extends TimelineSource>(
  events: T[],
  dayKey: string,
): (Omit<T, 'startsAt' | 'endsAt'> & {
  /** Narrowed from `TimelineSource` — kept only when both are set. */
  startsAt: string;
  endsAt: string;
  /** True when this item's [start, end) interval overlaps any other item on the day. */
  overlaps: boolean;
})[] {
  const touching = events
    .filter(
      (event): event is T & { startsAt: string; endsAt: string } =>
        !event.allDay && event.startsAt !== null && event.endsAt !== null,
    )
    .filter((event) => berlinDateKey(event.startsAt) === dayKey || berlinDateKey(event.endsAt) === dayKey)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  return touching.map((event) => {
    const start = new Date(event.startsAt).getTime();
    const end = new Date(event.endsAt).getTime();
    const overlaps = touching.some(
      (other) =>
        other !== event &&
        start < new Date(other.endsAt).getTime() &&
        new Date(other.startsAt).getTime() < end,
    );
    return { ...event, overlaps };
  });
}

/**
 * The item to bring into view when the agenda opens (AK4): today, the first item
 * that hasn't ended yet (may already be in progress); any other day, simply the
 * first item. `null` when there's nothing to focus (empty list, or today with
 * every item already ended).
 */
export function nextInAgenda<T extends { endsAt: string }>(
  items: T[],
  now: Date,
  isToday: boolean,
): T | null {
  if (isToday) {
    return items.find((item) => new Date(item.endsAt).getTime() > now.getTime()) ?? null;
  }
  return items[0] ?? null;
}

/**
 * All-day events whose `[startDate, endDate]` range (both are date keys,
 * `YYYY-MM-DD` — lexicographic order matches calendar order) covers `dayKey`.
 * A month/year boundary inside that range needs no special casing here: date
 * keys compare correctly across it, and `addDays` (used to page `dayKey`
 * day-by-day) already carries the rollover.
 */
export function allDayEventsForDay<T extends TimelineSource>(
  events: T[],
  dayKey: string,
): (T & {
  startDate: string;
  endDate: string;
  /** True when the bar's range reaches beyond `dayKey` on that side — the bar's
   *  edge there is squared off with a chevron instead of a rounded end, so a
   *  3-day event reads as one continuous shape across the days it's paged
   *  through, not three unrelated bars (AC2/AC3). */
  continuesBefore: boolean;
  continuesAfter: boolean;
})[] {
  return events
    .filter(
      (event): event is T & { startDate: string; endDate: string } =>
        event.allDay && event.startDate !== null && event.endDate !== null,
    )
    .filter((event) => event.startDate <= dayKey && dayKey <= event.endDate)
    .map((event) => ({
      ...event,
      continuesBefore: event.startDate < dayKey,
      continuesAfter: event.endDate > dayKey,
    }));
}

export interface AllDayBand {
  id: string;
  title: string;
  category: EventView['category'];
  /** 0-based column indices into the `visibleDays` array passed in — the
   *  week-strip's grid columns the band spans. */
  startCol: number;
  endCol: number;
  /** True when the event's own range reaches past that edge of `visibleDays`
   *  (issue #1013, AK9) — squared off there, rounded only where the event
   *  actually starts/ends. Deliberately measured against the *window's*
   *  edges, unlike `allDayEventsForDay`'s per-day `continuesBefore`/`-after`,
   *  which compare against a single day. */
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** 0-based row the band sits in, assigned here rather than left to CSS
   *  Grid's auto-placement (issue #1061): that placement is "sparse" and
   *  never backtracks, so a single band spanning the whole window pushed
   *  every later band onto a fresh row — even one whose columns an earlier
   *  row still had free. */
  row: number;
}

/**
 * All-day/multi-day bands across the week strip's visible 7-day window
 * (issue #1013, AK8–12) — one band per event, deduplicated by `id` the same
 * way `categoriesForDay`/`monthEventCounts` dedupe (a multi-day event shares
 * one id across every day it covers; a weekly all-day series gets a fresh id
 * per occurrence, so each occurrence gets its own band). Built on
 * `allDayEventsForDay` per visible day, so a band always agrees with that
 * day's dots/agenda by construction rather than a second, parallel rule.
 *
 * Stably sorted (`startCol`, then `startDate`, then `title`), then packed
 * into rows first-fit (issue #1061): every band takes the lowest row no
 * already-placed band shares a column with. In `startCol` order that is
 * plain interval-graph colouring — a row is free from `startCol` on exactly
 * when its last band ended before it, so one `endCol` per row is the entire
 * bookkeeping.
 *
 * Capped at `maxRows` (default 3 for the week strip; the month-grid card
 * passes 2 per week row, issue #1043). Rows are what cost card height, so
 * rows are what the cap counts (issue #1061 — it counted bands before, which
 * dropped a band even where a row still had room for it): a band that only
 * finds space in row `maxRows` or beyond falls away, one that fits beside an
 * earlier band never does. The agenda below already lists every event on a
 * day in full, so a dropped band loses nothing the user can't see there.
 */
export function allDayBandsForWindow<T extends TimelineSource>(
  visibleDays: string[],
  occurrencesForDay: (day: string) => T[],
  maxRows: number = 3,
): AllDayBand[] {
  const windowStart = visibleDays[0];
  const windowEnd = visibleDays[visibleDays.length - 1];
  const bands = new Map<string, Omit<AllDayBand, 'row'> & { startDate: string }>();

  visibleDays.forEach((day, col) => {
    for (const item of allDayEventsForDay(occurrencesForDay(day), day)) {
      const existing = bands.get(item.id);
      if (existing) {
        existing.startCol = Math.min(existing.startCol, col);
        existing.endCol = Math.max(existing.endCol, col);
        continue;
      }
      bands.set(item.id, {
        id: item.id,
        title: item.title,
        category: item.category,
        startCol: col,
        endCol: col,
        continuesBefore: item.startDate < windowStart,
        continuesAfter: item.endDate > windowEnd,
        startDate: item.startDate,
      });
    }
  });

  const sorted = [...bands.values()].sort(
    (a, b) =>
      a.startCol - b.startCol ||
      a.startDate.localeCompare(b.startDate) ||
      a.title.localeCompare(b.title),
  );

  /** Last column each row is occupied up to — `rowEnds[r]` is the `endCol` of
   *  the rightmost band already in row `r`. Because `sorted` runs in
   *  `startCol` order, a row is free for the next band exactly when that
   *  number is smaller than the band's own `startCol`. */
  const rowEnds: number[] = [];
  const placed: AllDayBand[] = [];

  for (const band of sorted) {
    let row = rowEnds.findIndex((end) => end < band.startCol);
    if (row === -1) row = rowEnds.length;
    if (row >= maxRows) continue;
    rowEnds[row] = band.endCol;
    placed.push({
      id: band.id,
      title: band.title,
      category: band.category,
      startCol: band.startCol,
      endCol: band.endCol,
      continuesBefore: band.continuesBefore,
      continuesAfter: band.continuesAfter,
      row,
    });
  }

  return placed;
}

/** A category's colour token (var() reference) — the single place this category
 *  → token mapping lives. Named for its original edge/border use; also feeds
 *  dots (calendar-strip.tsx) and, since issue #974, the overview's start-time
 *  ink (events-overview-section.css mixes it toward --text for contrast). */
export function categoryEdgeVar(category: EventView['category']): string {
  return category ? `var(--cat-${category})` : 'var(--area-events)';
}

const WEEKDAY_SHORT_UTC_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  timeZone: 'UTC',
});

/**
 * All-day band's range text (issue #924, AK4): "Ganztägig" for a single day,
 * "Ganztägig · Mo–Fr" once the bar continues before/after the day it's shown
 * on — the range now carries the fortsetzungshinweis that the removed
 * chevrons used to (#555 AC3 still holds, just a different carrier). Weekday
 * abbreviations of the event's own `startDate`/`endDate`, not of the day it's
 * rendered on, so a multi-day event reads the same range on every day it's
 * paged through. `weekday: 'short'` alone (no other date field) is the one
 * Intl combination that omits the trailing period German short weekdays
 * otherwise get (contrast `event-editor.tsx`'s `whenLabel`).
 */
export function allDayRangeLabel(item: {
  startDate: string;
  endDate: string;
  continuesBefore: boolean;
  continuesAfter: boolean;
}): string {
  if (!item.continuesBefore && !item.continuesAfter) return 'Ganztägig';
  const start = WEEKDAY_SHORT_UTC_FORMATTER.format(parseDateKey(item.startDate));
  const end = WEEKDAY_SHORT_UTC_FORMATTER.format(parseDateKey(item.endDate));
  return `Ganztägig · ${start}–${end}`;
}

export interface UpcomingEvent extends Omit<EventView, 'startsAt' | 'endsAt'> {
  /** Narrowed from `EventView` — `upcomingEventsToday` only ever keeps scheduled events. */
  startsAt: string;
  endsAt: string;
}

/**
 * Scheduled (non-all-day) events on today's Berlin calendar day that haven't ended
 * yet, earliest start first (issue #559, S8 of #473). The first entry is "the next
 * event" for the overview's countdown — it may already be in progress; the rest
 * render as the thin "rest of day" rows.
 */
export function upcomingEventsToday(events: EventView[], now: Date): UpcomingEvent[] {
  const dayKey = berlinNow(now).dateKey;
  return events
    .filter(
      (event): event is EventView & { startsAt: string; endsAt: string } =>
        !event.allDay && event.startsAt !== null && event.endsAt !== null,
    )
    .filter((event) => berlinDateKey(event.startsAt) === dayKey)
    .filter((event) => new Date(event.endsAt).getTime() > now.getTime())
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/**
 * "in 40 Min" / "in 2 Std 5 Min" for an event starting at `startsAt`, "Jetzt" once
 * it has started — never a negative countdown, since `upcomingEventsToday`'s first
 * entry may already be in progress (issue #559).
 */
export function formatCountdown(now: Date, startsAt: string): string {
  const diffMinutes = Math.round((new Date(startsAt).getTime() - now.getTime()) / 60_000);
  if (diffMinutes <= 0) return 'Jetzt';
  if (diffMinutes < 60) return `in ${diffMinutes} Min`;
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  return minutes === 0 ? `in ${hours} Std` : `in ${hours} Std ${minutes} Min`;
}

/**
 * "30 Min" / "1 Std" / "1 Std 30 Min" for an agenda row's second line (issue
 * #923, AK1) — same wording as `formatCountdown`, but from a fixed
 * `endsAt − startsAt` span instead of a countdown to now.
 */
export function formatDuration(startsAt: string, endsAt: string): string {
  const minutes = Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60_000);
  if (minutes < 60) return `${minutes} Min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} Std` : `${hours} Std ${rest} Min`;
}

const MONTH_TITLE_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * "Juli 2026" for the calendar header (issue #628, S1 of #622) — `timeZone:
 * 'UTC'` is required, not cosmetic: `parseDateKey` anchors `dateKey` at UTC
 * midnight, so formatting in the device's local zone would shift the day
 * (and sometimes the month) at a month boundary.
 */
export function formatMonthTitle(dateKey: string): string {
  return MONTH_TITLE_FORMATTER.format(parseDateKey(dateKey));
}

const MONTH_NAME_FORMATTER = new Intl.DateTimeFormat('de-DE', { month: 'long', timeZone: 'UTC' });
const YEAR_LABEL_FORMATTER = new Intl.DateTimeFormat('de-DE', { year: 'numeric', timeZone: 'UTC' });

/** "August" for the calendar header's month view title (issue #898) — same
 *  UTC-anchoring caveat as `formatMonthTitle`. */
export function monthName(dateKey: string): string {
  return MONTH_NAME_FORMATTER.format(parseDateKey(dateKey));
}

/** "2026" for the calendar header's month view eyebrow (issue #898) — same
 *  UTC-anchoring caveat as `formatMonthTitle`. */
export function yearLabel(dateKey: string): string {
  return YEAR_LABEL_FORMATTER.format(parseDateKey(dateKey));
}

const DAY_HEADING_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});

/** "Samstag, 15. August" for the month view's day-agenda heading (issue #959,
 *  T2 of #957) — same UTC-anchoring caveat as `formatMonthTitle`. */
export function formatDayHeading(dateKey: string): string {
  return DAY_HEADING_FORMATTER.format(parseDateKey(dateKey));
}

/** `dateKey` parsed as a UTC-anchored `Date` — machine-independent, see `addDays`. */
export function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Inverse of `parseDateKey` — exported for callers that need to build a date key off UTC-field arithmetic `addDays` can't express, e.g. `addMonths` (ics-fetch's horizon window). */
export function formatDateKey(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * `dateKey` shifted by `delta` days — pure string arithmetic via a UTC-anchored
 * `Date` (never the device's local timezone, unlike due-today.ts's `weekDays`),
 * so paging the timeline day-by-day is independent of the machine it runs on.
 */
export function addDays(dateKey: string, delta: number): string {
  const date = parseDateKey(dateKey);
  date.setUTCDate(date.getUTCDate() + delta);
  return formatDateKey(date);
}

/** Days from `a` to `b` (`b - a`) — pure date-key arithmetic, see `addDays`. */
export function dateKeyDiff(a: string, b: string): number {
  return Math.round((parseDateKey(b).getTime() - parseDateKey(a).getTime()) / 86_400_000);
}

/**
 * `dateKey` shifted by `delta` calendar months (issue #560's ICS-abo horizon
 * window) — `setUTCMonth` rolls a day that doesn't exist in the target month
 * (e.g. 31 Jan + 1 month) forward into the month after, same "never silently
 * shift within the same call" caveat as `Date` itself; the horizon window this
 * feeds only cares about the month boundary, not the exact day.
 */
export function addMonths(dateKey: string, delta: number): string {
  const date = parseDateKey(dateKey);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return formatDateKey(date);
}

/**
 * `dateKey` shifted by `delta` months, same day-of-month, clamped to the
 * target month's last day — 31.01. + 1 → 28.02. (29.02. in a leap year),
 * never rolling over into the following month, unlike `addMonths` above
 * (issue #662, S5 of #622, the decision that #630's `‹ ›` month-buttons will
 * reuse this same helper for).
 */
export function addMonthsClamped(dateKey: string, delta: number): string {
  const date = parseDateKey(dateKey);
  const day = date.getUTCDate();
  const targetMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1));
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0),
  ).getUTCDate();
  targetMonth.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return formatDateKey(targetMonth);
}

/** The Mon–Sun date keys of the week containing `dateKey`, Monday first. */
export function weekDaysFor(dateKey: string): string[] {
  const date = parseDateKey(dateKey);
  const weekday = date.getUTCDay(); // 0 = Sunday
  const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
  return Array.from({ length: 7 }, (_, offset) => addDays(dateKey, diffToMonday + offset));
}

/**
 * Full Mon–Sun weeks covering the month containing `dateKey` (issue #556, S5):
 * the 1st rolled back to its Monday, the last rolled forward to its Sunday,
 * neighbour-month days included (dimmed in the UI via `data-outside-month`) so
 * every row stays a complete week. Always 35 or 42 keys, same UTC anchoring as
 * `addDays`/`weekDaysFor` — device-timezone independent.
 */
export function monthDaysFor(dateKey: string): string[] {
  const date = parseDateKey(dateKey);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const firstKey = formatDateKey(new Date(Date.UTC(year, month, 1)));
  const lastKey = formatDateKey(new Date(Date.UTC(year, month + 1, 0)));
  const gridStart = weekDaysFor(firstKey)[0];
  const gridEnd = weekDaysFor(lastKey)[6];

  const days: string[] = [];
  for (let key = gridStart; key <= gridEnd; key = addDays(key, 1)) {
    days.push(key);
  }
  return days;
}

/**
 * `radiusDays` day keys either side of `anchorDay`, inclusive, ascending
 * (`2 * radiusDays + 1` keys total, `anchorDay` itself always the middle
 * entry) — the buffered window the week-strip carousel (calendar-strip.tsx)
 * rolls through continuously, day by day (issue #813, replaces the 3-page
 * `pageAnchors` whose hard page edges made a swipe snap to a whole week).
 */
export function dayWindow(anchorDay: string, radiusDays: number): string[] {
  return Array.from({ length: 2 * radiusDays + 1 }, (_, index) => addDays(anchorDay, index - radiusDays));
}

/**
 * `radiusWeeks` Mon–Sun weeks either side of the week containing `anchorDay`,
 * inclusive, ascending (`2 * radiusWeeks + 1` weeks total, the anchor's own
 * week always the middle entry) — the buffered window the month-strip
 * carousel rolls through vertically, week by week (issue #813, replaces
 * `pageAnchors`'s whole-month paging, reverses issue #805's month behaviour).
 */
export function weekWindow(anchorDay: string, radiusWeeks: number): string[][] {
  const anchorMonday = weekDaysFor(anchorDay)[0];
  return Array.from({ length: 2 * radiusWeeks + 1 }, (_, index) =>
    weekDaysFor(addDays(anchorMonday, (index - radiusWeeks) * 7)),
  );
}

/**
 * The categories of the *scheduled* events on `dateKey`, deduplicated and
 * stably ordered (`CATEGORIES` order from use-events.ts, `null` last) — one
 * dot per category, not per event (issue #556, S5).
 *
 * All-day and multi-day events are deliberately left out (issue #1061): they
 * already have their own band under the day cells (`allDayBandsForWindow`),
 * and that band says everything the dot could plus what it couldn't — the
 * title, and how far the event runs. A dot beside it was the same fact twice.
 * Day membership therefore comes from `agendaForDay` alone, the one predicate
 * the timeline itself uses for the scheduled part of a day (issue #612's rule,
 * now narrowed to that half).
 *
 * Takes already-expanded `Occurrence`s, not raw `events` rows (issue #612). A
 * series' later instances only exist after `expandForDay`, and this file cannot
 * call it itself — recurrence.ts imports from here, so the arrow points one way
 * only (see `TimelineSource`).
 *
 * Capped at `maxDots` (default 4) so the day cell never overflows — the week
 * strip keeps the default, the month-grid card (issue #958) passes 3.
 */
const CATEGORY_ORDER: EventView['category'][] = ['privat', 'arbeit', 'gesundheit', 'sport', 'familie', null];
const MAX_DOTS_PER_DAY = 4;

export function categoriesForDay<T extends TimelineSource>(
  occurrences: T[],
  dateKey: string,
  maxDots: number = MAX_DOTS_PER_DAY,
): EventView['category'][] {
  const present = new Set(
    agendaForDay(occurrences, dateKey).map((occurrence) => occurrence.category),
  );
  return CATEGORY_ORDER.filter((category) => present.has(category)).slice(0, maxDots);
}

/**
 * Days of the calendar month `focusMonth` (`YYYY-MM`) itself, excluding the
 * dimmed neighbour-month days `monthDaysFor`'s grid also carries.
 */
function daysOfMonth(focusMonth: string): string[] {
  return monthDaysFor(`${focusMonth}-01`).filter((day) => day.slice(0, 7) === focusMonth);
}

/**
 * Chip counts for the calendar header's month view (issue #898): how many
 * distinct events touch `focusMonth` (`YYYY-MM`), and how many of those are
 * all-day — "nur was die Daten hergeben" (#834), not a slot-by-slot tally.
 *
 * Takes a per-day occurrence lookup rather than raw `events` (same one-way
 * import direction as `categoriesForDay` — this file cannot call
 * `expandForDay` itself, recurrence.ts imports from here). Reuses
 * `agendaForDay`/`allDayEventsForDay` rather than `occurrencesForDay`'s raw
 * result: `expandForDay` pushes every non-recurring event for every day it's
 * asked about (recurrence.ts), so day membership only comes from those two
 * filters. Deduped by `Occurrence.id` — a multi-day event shares one id
 * across every day it covers, so it counts once; a weekly series gets a
 * fresh id per occurrence (`${eventId}:${date}`), so it counts once per
 * occurrence in the month.
 */
export function monthEventCounts<T extends TimelineSource>(
  focusMonth: string,
  occurrencesForDay: (day: string) => T[],
): { total: number; allDay: number } {
  const seen = new Map<string, boolean>();
  for (const day of daysOfMonth(focusMonth)) {
    const occurrences = occurrencesForDay(day);
    for (const item of [...agendaForDay(occurrences, day), ...allDayEventsForDay(occurrences, day)]) {
      if (!seen.has(item.id)) seen.set(item.id, item.allDay);
    }
  }
  const total = seen.size;
  const allDay = [...seen.values()].filter(Boolean).length;
  return { total, allDay };
}
