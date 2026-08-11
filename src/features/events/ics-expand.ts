/**
 * Expands `parseIcs`'s output into concrete, all-day `SubscribedEvent`
 * instances (issue #560, ADR-0022) — pure, no DB/DOM, Vitest-testable like
 * ics-parse.ts. Series expansion reuses `occurrencesOnDay` (recurrence.ts)
 * instead of a second recurrence engine; a `RRULE` with no `COUNT`/`UNTIL`
 * would otherwise run forever, so every event — recurring or not — is capped
 * to `horizon` (the caller, `use-ics-subscriptions.ts`, picks the window).
 */

import { addDays, addMonths, dateKeyDiff } from './event-time';
import type { ParsedIcsEvent } from './ics-parse';
import { occurrencesOnDay } from './recurrence';
import { berlinNow } from '@/push/schedule';
import type { SubscribedEvent } from '@/local/dexie';

/** Inclusive `YYYY-MM-DD` window series/single events are expanded/filtered into. */
export interface IcsHorizon {
  start: string;
  end: string;
}

/** Feiertage/geteilte Kalender ändern sich selten — ein knappes Fenster würde nur unnötig oft nachfragen (ADR-0022). */
export const ICS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function isIcsStale(fetchedAt: string | null, now: Date = new Date()): boolean {
  if (fetchedAt === null) return true;
  return now.getTime() - new Date(fetchedAt).getTime() >= ICS_REFRESH_INTERVAL_MS;
}

/** −1 Monat … +12 Monate um heute (ADR-0022) — deckelt eine unbegrenzte `RRULE` und die insgesamt gespeicherte Menge. */
export function icsHorizon(now: Date = new Date()): IcsHorizon {
  const { dateKey } = berlinNow(now);
  return { start: addMonths(dateKey, -1), end: addMonths(dateKey, 12) };
}

/** Expands `parsed` into `SubscribedEvent`s, all within `horizon` — a non-recurring event outside it is dropped, same as a series' out-of-range occurrences. */
export function expandIcsEvents(parsed: ParsedIcsEvent[], horizon: IcsHorizon): SubscribedEvent[] {
  const result: SubscribedEvent[] = [];

  for (const event of parsed) {
    if (!event.rrule) {
      if (event.startDate >= horizon.start && event.startDate <= horizon.end) {
        result.push({ uid: event.uid, title: event.title, startDate: event.startDate, endDate: event.endDate });
      }
      continue;
    }

    const durationDays = dateKeyDiff(event.startDate, event.endDate);
    const exDates = new Set(event.exDates);
    for (let dateKey = horizon.start; dateKey <= horizon.end; dateKey = addDays(dateKey, 1)) {
      if (exDates.has(dateKey)) continue;
      if (!occurrencesOnDay(event.rrule, event.startDate, dateKey)) continue;
      result.push({ uid: event.uid, title: event.title, startDate: dateKey, endDate: addDays(dateKey, durationDays) });
    }
  }

  return result;
}
