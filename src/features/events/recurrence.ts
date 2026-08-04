/**
 * Recurring-event expansion (issue #557, S6 of #473) — pure, no DB/DOM, so it's
 * Vitest-testable like event-time.ts. Turns a day's `events` rows (some plain,
 * some recurring via the `recurrence` JSON shape from schema.ts) plus that
 * day's `event_exceptions` overrides into the flat list of instances the
 * timeline actually renders.
 *
 * Expansion happens on the Berlin wall clock, not UTC-instant arithmetic: a
 * weekly 09:00 anchor must read 09:00 on every occurrence, including across a
 * DST changeover, which a fixed millisecond stride would not give (issue #552
 * AC5's over-midnight note is the same family of bug). `berlinInstant`
 * (src/push/schedule.ts) is the inverse of the `berlinNow` this app already
 * schedules push reminders with — no second timezone implementation.
 */

import { berlinInstant, berlinNow } from '@/push/schedule';
import { addDays, berlinMinutesOfDay, dateKeyDiff, parseDateKey, weekDaysFor } from './event-time';
import type { EventExceptionView } from './use-event-exceptions';
import type { EventView } from './use-events';

type Recurrence = NonNullable<EventView['recurrence']>;

/**
 * One rendered instance — a plain event as-is, or one occurrence of a
 * recurring series with that day's exception (if any) applied. `id` is the
 * timeline card key: the anchor `events` row's own id for a single event,
 * `${eventId}:${originalDate}` for a series instance (never collides with a
 * real row id, which is a UUID). `originalDate` is present only for a series
 * instance — callers use it to tell "this can be moved/cancelled via
 * `event_exceptions`" apart from "this is the event itself".
 */
export interface Occurrence {
  id: string;
  eventId: string;
  originalDate?: string;
  title: string;
  allDay: boolean;
  startsAt: string | null;
  endsAt: string | null;
  startDate: string | null;
  endDate: string | null;
  category: EventView['category'];
}

/** 0 = Mo … 6 = So (Montag-erster wie `weekDaysFor`), not JS's `getUTCDay()` (0 = So). */
function weekdayIndex(dateKey: string): number {
  return (parseDateKey(dateKey).getUTCDay() + 6) % 7;
}

/** Does `dateKey` match the series' freq/interval/byWeekday pattern — ignores `until`/`count`. */
function matchesPattern(rule: Recurrence, anchorDateKey: string, dateKey: string): boolean {
  const diffDays = dateKeyDiff(anchorDateKey, dateKey);
  if (diffDays < 0) return false;

  switch (rule.freq) {
    case 'daily':
      return diffDays % rule.interval === 0;
    case 'weekly': {
      const anchorMonday = weekDaysFor(anchorDateKey)[0];
      const dateMonday = weekDaysFor(dateKey)[0];
      const weeksBetween = dateKeyDiff(anchorMonday, dateMonday) / 7;
      if (weeksBetween % rule.interval !== 0) return false;
      const weekdays = rule.byWeekday ?? [weekdayIndex(anchorDateKey)];
      return weekdays.includes(weekdayIndex(dateKey));
    }
    case 'monthly': {
      const anchor = parseDateKey(anchorDateKey);
      const target = parseDateKey(dateKey);
      if (target.getUTCDate() !== anchor.getUTCDate()) return false;
      const monthsBetween =
        (target.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
        (target.getUTCMonth() - anchor.getUTCMonth());
      return monthsBetween % rule.interval === 0;
    }
    case 'yearly': {
      const anchor = parseDateKey(anchorDateKey);
      const target = parseDateKey(dateKey);
      if (
        target.getUTCDate() !== anchor.getUTCDate() ||
        target.getUTCMonth() !== anchor.getUTCMonth()
      ) {
        return false;
      }
      const yearsBetween = target.getUTCFullYear() - anchor.getUTCFullYear();
      return yearsBetween % rule.interval === 0;
    }
  }
}

/**
 * Does the series anchored on `anchorDateKey` occur on `dateKey`? A day that
 * doesn't exist in a given month/year (e.g. 31st in a 30-day month, 29 Feb in
 * a non-leap year) simply never equals any real `dateKey`, so `matchesPattern`
 * skips it on its own — no explicit clamping needed (Regel: nie stillschweigend
 * verschieben).
 */
export function occurrencesOnDay(rule: Recurrence, anchorDateKey: string, dateKey: string): boolean {
  if (!matchesPattern(rule, anchorDateKey, dateKey)) return false;
  if (rule.until !== undefined && dateKey > rule.until) return false;

  if (rule.count !== undefined) {
    let occurrenceNumber = 0;
    let cursor = anchorDateKey;
    while (cursor <= dateKey) {
      if (matchesPattern(rule, anchorDateKey, cursor)) occurrenceNumber++;
      cursor = addDays(cursor, 1);
    }
    if (occurrenceNumber > rule.count) return false;
  }

  return true;
}

function anchorDateKeyOf(event: EventView): string | null {
  if (event.allDay) return event.startDate;
  if (!event.startsAt) return null;
  return berlinNow(new Date(event.startsAt)).dateKey;
}

function timedOccurrenceOn(
  event: EventView & { startsAt: string; endsAt: string },
  originalDate: string,
): { startsAt: string; endsAt: string } {
  const anchorMinutes = berlinMinutesOfDay(event.startsAt);
  const durationMs = new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime();
  const startInstant = berlinInstant(originalDate, anchorMinutes);
  return {
    startsAt: startInstant.toISOString(),
    endsAt: new Date(startInstant.getTime() + durationMs).toISOString(),
  };
}

function allDayOccurrenceOn(
  event: EventView & { startDate: string; endDate: string },
  originalDate: string,
): { startDate: string; endDate: string } {
  const durationDays = dateKeyDiff(event.startDate, event.endDate);
  return { startDate: originalDate, endDate: addDays(originalDate, durationDays) };
}

function toSeriesOccurrence(
  event: EventView,
  originalDate: string,
  exception: EventExceptionView | undefined,
): Occurrence {
  const shared = { id: `${event.id}:${originalDate}`, eventId: event.id, originalDate, title: event.title, allDay: event.allDay, category: event.category };

  if (event.allDay) {
    const base =
      event.startDate && event.endDate
        ? allDayOccurrenceOn(event as EventView & { startDate: string; endDate: string }, originalDate)
        : { startDate: originalDate, endDate: originalDate };
    const startDate = exception?.overrideStartDate ?? base.startDate;
    const endDate = exception?.overrideEndDate ?? base.endDate;
    return { ...shared, startsAt: null, endsAt: null, startDate, endDate };
  }

  const base =
    event.startsAt && event.endsAt
      ? timedOccurrenceOn(event as EventView & { startsAt: string; endsAt: string }, originalDate)
      : { startsAt: originalDate, endsAt: originalDate };
  const startsAt = exception?.overrideStartsAt ?? base.startsAt;
  const endsAt = exception?.overrideEndsAt ?? base.endsAt;
  return { ...shared, startsAt, endsAt, startDate: null, endDate: null };
}

/**
 * Every rendered instance on `dayKey` (a Berlin calendar day): non-recurring
 * events pass through unchanged, recurring `events` rows expand via
 * `occurrencesOnDay`, and a matching `event_exceptions` row (natural key
 * `(eventId, originalDate)`) either drops the instance (`cancelled`) or moves
 * it (override fields) — never touching the series row or any other instance
 * (S6 AC3/AC4).
 */
export function expandForDay(
  events: EventView[],
  exceptions: EventExceptionView[],
  dayKey: string,
): Occurrence[] {
  const result: Occurrence[] = [];

  for (const event of events) {
    if (!event.recurrence) {
      result.push({
        id: event.id,
        eventId: event.id,
        title: event.title,
        allDay: event.allDay,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        startDate: event.startDate,
        endDate: event.endDate,
        category: event.category,
      });
      continue;
    }

    const anchorDateKey = anchorDateKeyOf(event);
    if (!anchorDateKey) continue;
    if (!occurrencesOnDay(event.recurrence, anchorDateKey, dayKey)) continue;

    const exception = exceptions.find(
      (candidate) => candidate.eventId === event.id && candidate.originalDate === dayKey,
    );
    if (exception?.cancelled) continue;

    result.push(toSeriesOccurrence(event, dayKey, exception));
  }

  return result;
}
