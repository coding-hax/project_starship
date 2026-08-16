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

/** The card's left edge colour — the single place this category → token mapping lives. */
export function categoryEdgeVar(category: EventView['category']): string {
  return category ? `var(--cat-${category})` : 'var(--area-events)';
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

/** Below this delta, a calendar-strip drag still counts as a tap — matches `TAP_TOLERANCE_PX` in calendar-strip.tsx (issue #764). */
export const DRAG_TAP_TOLERANCE_PX = 8;
/** Pixels per day at the start of a drag, before the curve accelerates. */
const DRAG_SCRUB_UNIT_PX = 50;
/** Growth rate of days-per-pixel past the tap tolerance — the gesture speeds up the further it travels. */
const DRAG_SCRUB_EXPONENT = 1.6;
/** A single drag, however far, never covers more than this many days in one gesture (issue #764). */
export const DRAG_MAX_DAYS = 20;

/**
 * Maps a raw pointer-drag distance (px, signed) to a day offset for the
 * calendar strip's live-scrub gesture (issue #764): a small movement steps
 * one day at a time, a larger one accelerates up to `DRAG_MAX_DAYS` in a
 * single gesture — the same curve drives the week view's horizontal drag and
 * the month view's vertical one. Below `DRAG_TAP_TOLERANCE_PX` this is 0 so a
 * tap never moves the selection.
 */
export function dragDayDelta(distancePx: number): number {
  const magnitude = Math.abs(distancePx);
  if (magnitude <= DRAG_TAP_TOLERANCE_PX) return 0;
  const effective = magnitude - DRAG_TAP_TOLERANCE_PX;
  const days = Math.round((effective / DRAG_SCRUB_UNIT_PX) ** DRAG_SCRUB_EXPONENT);
  return Math.sign(distancePx) * Math.min(days, DRAG_MAX_DAYS);
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
 * The categories present on `dateKey`, deduplicated and stably ordered
 * (`CATEGORIES` order from use-events.ts, `null` last) — one dot per category,
 * not per event (issue #556, S5).
 *
 * Takes already-expanded `Occurrence`s, not raw `events` rows (issue #612). A
 * series' later instances only exist after `expandForDay`, and this file cannot
 * call it itself — recurrence.ts imports from here, so the arrow points one way
 * only (see `TimelineSource`). Day membership then reuses the timeline's own two
 * predicates instead of a third, private comparison: a day carries a dot exactly
 * when the timeline below it renders something — all-day and multi-day events
 * (which have no `startsAt` at all) included.
 *
 * Capped at 4 so the day cell never overflows.
 */
const CATEGORY_ORDER: EventView['category'][] = ['privat', 'arbeit', 'gesundheit', 'sport', 'familie', null];
const MAX_DOTS_PER_DAY = 4;

export function categoriesForDay<T extends TimelineSource>(
  occurrences: T[],
  dateKey: string,
): EventView['category'][] {
  const present = new Set(
    [...agendaForDay(occurrences, dateKey), ...allDayEventsForDay(occurrences, dateKey)].map(
      (occurrence) => occurrence.category,
    ),
  );
  return CATEGORY_ORDER.filter((category) => present.has(category)).slice(0, MAX_DOTS_PER_DAY);
}
