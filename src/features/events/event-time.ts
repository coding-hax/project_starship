/**
 * Pure timeline-layout logic (issue #553, S2 of #473; all-day band issue #555,
 * S4; overview countdown issue #559, S8) — no DB, no DOM, so it's Vitest-testable
 * like habits/due-today.ts and schedule-rules.ts.
 */

import { berlinNow } from '@/push/schedule';
import type { EventView } from './use-events';

const MINUTES_PER_DAY = 1440;

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
 * `--touch-target` (44px, tokens.css) against the 1440px-tall day axis that
 * `event-timeline.css` builds from `--hour-height: 60px` × 24 — that sizing makes
 * 1 minute == 1 px, so the same fraction that positions a card in percent also
 * floors its height at a tappable size.
 */
const MIN_HEIGHT_PCT = (44 / MINUTES_PER_DAY) * 100;

/**
 * Visible, scheduled events on `dayKey` (a Berlin calendar day, `YYYY-MM-DD`),
 * positioned on a 0–24h axis. All-day events and events with no `startsAt`/
 * `endsAt` are filtered out. An event that starts before `dayKey` or ends after
 * it is clamped to the day's own bounds (0 / 1440 minutes) — a real over-midnight
 * split into two cards is S4, not built here.
 */
export function layoutForDay<T extends TimelineSource>(
  events: T[],
  dayKey: string,
): (Omit<T, 'startsAt' | 'endsAt'> & {
  /** Narrowed from `TimelineSource` — kept only when both are set. */
  startsAt: string;
  endsAt: string;
  /** Top offset as a percentage of the 0–24h axis (`minutesOfDay / 1440 * 100`). */
  topPct: number;
  /** Card height as a percentage of the axis, floored so the tap target stays reachable. */
  heightPct: number;
})[] {
  return events
    .filter(
      (event): event is T & { startsAt: string; endsAt: string } =>
        !event.allDay && event.startsAt !== null && event.endsAt !== null,
    )
    .filter((event) => berlinDateKey(event.startsAt) === dayKey || berlinDateKey(event.endsAt) === dayKey)
    .map((event) => {
      const startMinutes =
        berlinDateKey(event.startsAt) === dayKey ? berlinMinutesOfDay(event.startsAt) : 0;
      const endMinutes =
        berlinDateKey(event.endsAt) === dayKey ? berlinMinutesOfDay(event.endsAt) : MINUTES_PER_DAY;
      const topPct = (startMinutes / MINUTES_PER_DAY) * 100;
      const heightPct = Math.max(((endMinutes - startMinutes) / MINUTES_PER_DAY) * 100, MIN_HEIGHT_PCT);
      return { ...event, topPct, heightPct };
    });
}

/** Now-line position as a percentage of the same 0–24h axis `layoutForDay` uses. */
export function nowLinePct(now: Date): number {
  return (berlinNow(now).minutesOfDay / MINUTES_PER_DAY) * 100;
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

/** `dateKey` parsed as a UTC-anchored `Date` — machine-independent, see `addDays`. */
export function parseDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDateKey(date: Date): string {
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
 * not per event (issue #556, S5). All-day/multi-day layout is S4; this places
 * an event by `berlinDateKey(startsAt)` only, which is enough for a dot.
 * Capped at 4 so the day cell never overflows.
 */
const CATEGORY_ORDER: EventView['category'][] = ['privat', 'arbeit', 'gesundheit', 'sport', 'familie', null];
const MAX_DOTS_PER_DAY = 4;

export function categoriesForDay(events: EventView[], dateKey: string): EventView['category'][] {
  const present = new Set(
    events.filter((event) => event.startsAt !== null && berlinDateKey(event.startsAt) === dateKey).map(
      (event) => event.category,
    ),
  );
  return CATEGORY_ORDER.filter((category) => present.has(category)).slice(0, MAX_DOTS_PER_DAY);
}
