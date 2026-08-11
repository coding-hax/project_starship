/**
 * Per-event push reminders ("15 Minuten vorher", issue #558, S7 of #473) — a
 * second phase in `sendDueReminders` (index.ts) alongside the fixed daily
 * slots (tasks-due/habits-open), not a `ReminderKind`: a slot is a fixed
 * time-of-day, while a reminder here is a moving point in time computed per
 * event (`start - reminderMinutes`), so it does not fit `dueSlots()`.
 *
 * `dueEventReminders` is pure (no DB/DOM), Vitest-testable like
 * `recurrence.ts`. `collectDueEventReminders` is the DB adapter `index.ts`
 * calls, reusing S6's `expandForDay` for series occurrences rather than
 * re-implementing recurrence expansion here.
 */

import { and, isNull, isNotNull } from 'drizzle-orm';
import { db } from '@/db';
import { events, eventExceptions, type Event, type EventException } from '@/db/schema';
import { expandForDay } from '@/features/events/recurrence';
import { addDays } from '@/features/events/event-time';
import { berlinNow } from '@/push/schedule';
import type { PushPayload } from '@/push/send';
import type { EventExceptionView } from '@/features/events/use-event-exceptions';
import type { EventView } from '@/features/events/use-events';

/**
 * `EventView` plus the two fields `expandForDay`'s input doesn't need but the
 * due-check here does — kept off `EventView` itself (see its doc comment: the
 * live-table hook never carries `reminderMinutes`/`deletedAt` today). Extra
 * properties on an object passed where `EventView` is expected are fine
 * (structural typing), so this still satisfies `expandForDay(events: EventView[], ...)`.
 */
export interface EventReminderSource extends EventView {
  reminderMinutes: number | null;
  deletedAt: string | null;
}

export interface DueEventReminder {
  /** `(kind, sendDate, slot)` dedup key's `slot` half — event id, or `${eventId}:${originalDate}` for a series occurrence. */
  lockSlot: string;
  /** Berlin calendar day of the occurrence — stable across a same-day move, changes only if the occurrence itself moves to another day. */
  sendDate: string;
  payload: PushPayload;
  /** The occurrence's actual start instant (ISO) — exposed for tests, not used for dedup. */
  occStart: string;
}

/**
 * A cron tick fires every 30 minutes (`.github/workflows/reminders.yml`), not
 * at the exact `start - reminderMinutes` instant, so a reminder is due once
 * that instant falls inside this trailing window: one interval plus buffer
 * for scheduling drift. A cron outage longer than this window is not caught
 * up — same stance as `dueSlots` (src/push/schedule.ts), which has no
 * lookback across `send_date` either.
 */
const LOOKBACK_MS = 45 * 60_000;

function isDue(remindAtMs: number, now: Date, lookbackMs: number): boolean {
  const nowMs = now.getTime();
  return remindAtMs <= nowMs && nowMs < remindAtMs + lookbackMs;
}

function buildPayload(title: string, startsAt: string): PushPayload {
  const { minutesOfDay } = berlinNow(new Date(startsAt));
  const hours = String(Math.floor(minutesOfDay / 60)).padStart(2, '0');
  const minutes = String(minutesOfDay % 60).padStart(2, '0');
  return { title: 'Termin', body: `${hours}:${minutes} Uhr — ${title}`, url: '/kalender' };
}

/**
 * Berlin calendar days a series occurrence could start on for it to be due
 * right now: the window `[now - lookback + lead, now + lead]` translated to
 * `startsAt`, widened by one day on each side so a same-day-of-week series
 * occurrence moved across midnight (`event_exceptions.overrideStartsAt`)
 * still turns up. Always a handful of days for realistic lead times, never
 * unbounded.
 */
function candidateDayKeys(now: Date, reminderMinutes: number, lookbackMs: number): string[] {
  const leadMs = reminderMinutes * 60_000;
  const rangeStart = new Date(now.getTime() - lookbackMs + leadMs);
  const rangeEnd = new Date(now.getTime() + leadMs);

  const firstKey = addDays(berlinNow(rangeStart).dateKey, -1);
  const lastKey = addDays(berlinNow(rangeEnd).dateKey, 1);

  const keys: string[] = [];
  for (let key = firstKey; key <= lastKey; key = addDays(key, 1)) {
    keys.push(key);
  }
  return keys;
}

/**
 * Every event reminder due right now — a single-instance event evaluated
 * once against its own `startsAt`, a recurring event evaluated once per
 * candidate day via `expandForDay` (which already applies that day's
 * `event_exceptions` override/cancellation, S6). Filters mirror the "belt to
 * its braces" pattern of `selectDueTasks`/`selectOpenHabits`: the DB query in
 * `collectDueEventReminders` already narrows the same way, this re-checks so
 * the pure function is fully testable without a database.
 */
export function dueEventReminders(
  sources: EventReminderSource[],
  exceptions: EventExceptionView[],
  now: Date,
  lookbackMs: number = LOOKBACK_MS,
): DueEventReminder[] {
  const due: DueEventReminder[] = [];

  for (const event of sources) {
    if (event.deletedAt !== null) continue;
    if (event.allDay) continue;
    if (event.reminderMinutes === null) continue;
    const leadMs = event.reminderMinutes * 60_000;

    if (!event.recurrence) {
      if (!event.startsAt) continue;
      const remindAt = new Date(event.startsAt).getTime() - leadMs;
      if (!isDue(remindAt, now, lookbackMs)) continue;
      due.push({
        lockSlot: event.id,
        sendDate: berlinNow(new Date(event.startsAt)).dateKey,
        payload: buildPayload(event.title, event.startsAt),
        occStart: event.startsAt,
      });
      continue;
    }

    for (const dayKey of candidateDayKeys(now, event.reminderMinutes, lookbackMs)) {
      const [occurrence] = expandForDay([event], exceptions, dayKey);
      if (!occurrence || occurrence.allDay || !occurrence.startsAt) continue;

      const remindAt = new Date(occurrence.startsAt).getTime() - leadMs;
      if (!isDue(remindAt, now, lookbackMs)) continue;

      due.push({
        lockSlot: occurrence.id,
        sendDate: occurrence.originalDate ?? dayKey,
        payload: buildPayload(event.title, occurrence.startsAt),
        occStart: occurrence.startsAt,
      });
    }
  }

  return due;
}

function toEventReminderSource(row: Event): EventReminderSource {
  return {
    id: row.id,
    title: row.title,
    allDay: row.allDay,
    startsAt: row.startsAt ? row.startsAt.toISOString() : null,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    startDate: row.startDate,
    endDate: row.endDate,
    category: row.category,
    recurrence: row.recurrence,
    origin: 'local',
    reminderMinutes: row.reminderMinutes,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

function toEventExceptionRow(row: EventException): EventExceptionView {
  return {
    id: row.id,
    eventId: row.eventId,
    originalDate: row.originalDate,
    cancelled: row.cancelled,
    overrideStartsAt: row.overrideStartsAt ? row.overrideStartsAt.toISOString() : null,
    overrideEndsAt: row.overrideEndsAt ? row.overrideEndsAt.toISOString() : null,
    overrideStartDate: row.overrideStartDate,
    overrideEndDate: row.overrideEndDate,
  };
}

/**
 * DB-side collector `index.ts` calls. Loads only events that could ever be
 * due (a reminder configured, not tombstoned) plus every live exception —
 * the same "load broadly, filter in pure code" shape `habits-open.ts` uses
 * for logs/freezes, reasonable at this app's single-owner scale.
 */
export async function collectDueEventReminders(now: Date): Promise<DueEventReminder[]> {
  const eventRows = await db
    .select()
    .from(events)
    .where(and(isNotNull(events.reminderMinutes), isNull(events.deletedAt)));

  const exceptionRows = await db.select().from(eventExceptions).where(isNull(eventExceptions.deletedAt));

  return dueEventReminders(
    eventRows.map(toEventReminderSource),
    exceptionRows.map(toEventExceptionRow),
    now,
  );
}
