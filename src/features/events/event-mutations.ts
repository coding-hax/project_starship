/**
 * Per-occurrence mutations for a recurring `events` row (issue #557, S6 of
 * #473): move or cancel a single occurrence ("nur dieser", AC3/AC4), or split
 * the series so a change only affects this and later occurrences ("alle
 * folgenden", AC5). All three write through the outbox (`@/local/outbox`),
 * same as every other mutation in the app (CLAUDE.md rule 8).
 *
 * `event_exceptions` cannot override `title`/`category` — only start/end and
 * `cancelled` (schema.ts's `eventExceptions` doc comment) — so "nur dieser"
 * is only ever offered by the editor when nothing but the time model changed;
 * a title/category edit has to go through `splitSeries` ("alle folgenden")
 * or the plain whole-series upsert instead.
 */

import { mutate } from '@/local/outbox';
import { addDays, dateKeyDiff } from './event-time';
import { anchorDateKeyOf, matchesPattern, type Recurrence } from './recurrence';
import type { EventExceptionView } from './use-event-exceptions';
import type { EventView } from './use-events';

/** Number of `rule` occurrences strictly before `dateKey`, ignoring `until`/`count` (own pattern only). */
function occurrencesBefore(rule: Recurrence, anchorDateKey: string, dateKey: string): number {
  let count = 0;
  let cursor = anchorDateKey;
  while (dateKeyDiff(cursor, dateKey) > 0) {
    if (matchesPattern(rule, anchorDateKey, cursor)) count++;
    cursor = addDays(cursor, 1);
  }
  return count;
}

/**
 * The head of a split series: `rule` bounded so its last occurrence is
 * strictly before `beforeDateKey` — used to end the original row right where
 * "alle folgenden" starts. Whichever end-bound style `rule` already used
 * (`until`, `count`, or neither) is preserved, just tightened.
 */
export function truncateRecurrence(
  rule: Recurrence,
  anchorDateKey: string,
  beforeDateKey: string,
): Recurrence {
  const truncated: Recurrence = { freq: rule.freq, interval: rule.interval };
  if (rule.byWeekday) truncated.byWeekday = rule.byWeekday;

  const dayBefore = addDays(beforeDateKey, -1);
  if (rule.until !== undefined) {
    truncated.until = rule.until < dayBefore ? rule.until : dayBefore;
  } else if (rule.count === undefined) {
    truncated.until = dayBefore;
  }
  if (rule.count !== undefined) {
    truncated.count = Math.min(rule.count, occurrencesBefore(rule, anchorDateKey, beforeDateKey));
  }
  return truncated;
}

/**
 * The tail of a split series: the same pattern re-anchored at `fromDateKey`
 * (itself an existing occurrence, so `matchesPattern` trivially holds there —
 * the cadence keeps lining up because `fromDateKey` was already a multiple of
 * `rule`'s own interval from the old anchor). `until` carries over unchanged
 * (an absolute date); `count` is reduced by however many occurrences already
 * happened before `fromDateKey`.
 */
export function remainingRecurrence(
  rule: Recurrence,
  anchorDateKey: string,
  fromDateKey: string,
): Recurrence {
  const remaining: Recurrence = { freq: rule.freq, interval: rule.interval };
  if (rule.byWeekday) remaining.byWeekday = rule.byWeekday;
  if (rule.until !== undefined) remaining.until = rule.until;
  if (rule.count !== undefined) {
    remaining.count = Math.max(0, rule.count - occurrencesBefore(rule, anchorDateKey, fromDateKey));
  }
  return remaining;
}

/** Only the fields a new split-off `events` row needs beyond its `recurrence`. */
export interface EventFields {
  title: string;
  allDay: boolean;
  startsAt: string | null;
  endsAt: string | null;
  startDate: string | null;
  endDate: string | null;
  category: EventView['category'];
}

/**
 * "Nur dieser" (AC3): move one occurrence by upserting its `event_exceptions`
 * row (natural key `eventId`+`originalDate`) — reuses an already-synced
 * exception's own id if one exists for this occurrence (same
 * find-before-mutate pattern as `useToggleHabitLog`), so a second move of the
 * same occurrence updates that row instead of racing the unique index with a
 * fresh insert.
 */
export async function moveOccurrence(
  eventId: string,
  originalDate: string,
  exceptions: EventExceptionView[],
  override: { startsAt: string; endsAt: string } | { startDate: string; endDate: string },
): Promise<void> {
  const existing = exceptions.find(
    (candidate) => candidate.eventId === eventId && candidate.originalDate === originalDate,
  );
  await mutate({
    table: 'event_exceptions',
    rowId: existing?.id,
    op: 'upsert',
    payload: {
      eventId,
      originalDate,
      cancelled: false,
      overrideStartsAt: 'startsAt' in override ? override.startsAt : null,
      overrideEndsAt: 'startsAt' in override ? override.endsAt : null,
      overrideStartDate: 'startDate' in override ? override.startDate : null,
      overrideEndDate: 'startDate' in override ? override.endDate : null,
    },
  });
}

/** "Ausfallen lassen" (AC4): same natural-key upsert as `moveOccurrence`, just `cancelled: true`. */
export async function cancelOccurrence(
  eventId: string,
  originalDate: string,
  exceptions: EventExceptionView[],
): Promise<void> {
  const existing = exceptions.find(
    (candidate) => candidate.eventId === eventId && candidate.originalDate === originalDate,
  );
  await mutate({
    table: 'event_exceptions',
    rowId: existing?.id,
    op: 'upsert',
    payload: {
      eventId,
      originalDate,
      cancelled: true,
      overrideStartsAt: null,
      overrideEndsAt: null,
      overrideStartDate: null,
      overrideEndDate: null,
    },
  });
}

/**
 * "Alle folgenden" on an edit (AC5): truncate the original series to end the
 * day before `fromDateKey`, then insert a new `events` row carrying `fields`
 * (the edited values) with the remaining pattern, re-anchored at
 * `fromDateKey`. If `fromDateKey` is the series' own first occurrence, there
 * is no head left to keep — this just rewrites the existing row in place
 * instead of leaving an empty, invisible one behind.
 *
 * `nextPattern` carries the form's own freq/interval/byWeekday/until/count
 * when the user *also* changed the recurrence in the same edit — used as-is
 * for the new tail (a freshly typed count/until means "starting from here",
 * not "however many of the old pattern's occurrences are left"; the two
 * don't even share a unit once frequency itself changes). Omitted, the tail
 * keeps the original pattern with its bound recomputed by
 * `remainingRecurrence`.
 */
export async function splitSeries(
  event: EventView,
  fromDateKey: string,
  fields: EventFields,
  nextPattern?: Recurrence,
): Promise<void> {
  const anchorDateKey = anchorDateKeyOf(event);
  if (!anchorDateKey || !event.recurrence) return;

  const remaining =
    nextPattern ?? remainingRecurrence(event.recurrence, anchorDateKey, fromDateKey);

  if (dateKeyDiff(anchorDateKey, fromDateKey) <= 0) {
    await mutate({
      table: 'events',
      rowId: event.id,
      op: 'upsert',
      payload: { ...fields, recurrence: remaining },
    });
    return;
  }

  const truncated = truncateRecurrence(event.recurrence, anchorDateKey, fromDateKey);
  await mutate({
    table: 'events',
    rowId: event.id,
    op: 'upsert',
    payload: { recurrence: truncated },
  });
  await mutate({ table: 'events', op: 'upsert', payload: { ...fields, recurrence: remaining } });
}

/**
 * "Alle folgenden" on a delete (AC5 via delete): end the series the day
 * before `fromDateKey`, no replacement row — there is nothing after to keep.
 */
export async function truncateSeriesFrom(event: EventView, fromDateKey: string): Promise<void> {
  const anchorDateKey = anchorDateKeyOf(event);
  if (!anchorDateKey || !event.recurrence) return;

  const truncated = truncateRecurrence(event.recurrence, anchorDateKey, fromDateKey);
  await mutate({
    table: 'events',
    rowId: event.id,
    op: 'upsert',
    payload: { recurrence: truncated },
  });
}
