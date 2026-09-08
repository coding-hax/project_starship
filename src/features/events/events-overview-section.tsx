'use client';

import type { CSSProperties } from 'react';
import { OverviewBlock, OverviewCardHead } from '@/ui/overview-block';
import { useBlockReady } from '@/ui/overview-ready';
import { useNow } from '@/ui/use-now';
import {
  categoryEdgeVar,
  formatCountdown,
  formatEventTime,
  formatNextTimeline,
  formatRestRowTime,
  nextUpcomingOccurrences,
  type NextOccurrence,
} from './event-time';
import { expandForDay } from './recurrence';
import { useEventExceptions } from './use-event-exceptions';
import { EVENT_CATEGORIES, useEvents } from './use-events';
import { useSubscribedEvents } from './use-ics-subscriptions';

/** "in 40 Min · Arbeit", the countdown alone without a category (issue #974,
 *  AK2), or just the category once there's no countdown to show for an
 *  all-day event (issue #1091, AK4) — `null` when there's neither. */
function nextMeta(now: Date, occurrence: NextOccurrence): string | null {
  const categoryLabel =
    EVENT_CATEGORIES.find((c) => c.value === occurrence.item.category)?.label ?? null;
  if (occurrence.item.allDay) return categoryLabel;
  const countdown = formatCountdown(now, occurrence.dayKey, occurrence.item.startsAt as string);
  return categoryLabel ? `${countdown} · ${categoryLabel}` : countdown;
}

/**
 * Overview section wrapper (issue #308) for "Nächster Termin" — the next event
 * across an unbounded horizon (issue #1091, Owner-Entscheidung 07.09.2026,
 * supersedes the same-day-only #559/#974 scope), rendered large with a
 * countdown; up to 3 more follow underneath as thin rows. `useNow` re-renders
 * every tick, so the countdown and day labels stay current without a reload.
 *
 * Reads `useEvents()` + `useEventExceptions()` (series expansion via
 * `expandForDay`, recurrence.ts) together with `useSubscribedEvents()`
 * (read-only ICS abos, ADR-0022) — a series instance or an abo'd event can be
 * the nearest thing on the calendar just as easily as a plain one.
 *
 * The loading `null` swallows this section's own `<h2>` too, so its arrival
 * moved every section below it — `useBlockReady` ties it into the overview's
 * single reveal point instead (issue #642); it now also waits on
 * `exceptions`, the second live query this section reads.
 *
 * Card head "Nächster Termin" → "Kalender" (issue #972, AK2/AK4): rendered
 * inside both the next-event card and the empty state, so a visible title
 * stands in the card head whether or not there is a next event.
 *
 * Row layout (issue #974, T3 von #971): the start time carries the row, large
 * and in the event's category colour, instead of a leading countdown line and
 * a trailing time-range line — the countdown/day-word moves into a muted meta
 * line next to the title, alongside the category. An all-day event has no
 * start time to anchor that big number on, so it's left out for those.
 * `formatNextTimeline` (issue #1091, AK4/AK5) adds a further line once the
 * event isn't today, or is all-day — carrying the date and/or the full time
 * span that the big number and the countdown alone no longer spell out.
 */
export function EventsOverviewSection() {
  const events = useEvents();
  const exceptions = useEventExceptions();
  const subscribed = useSubscribedEvents();
  const now = useNow();

  useBlockReady(events !== undefined && exceptions !== undefined);

  if (events === undefined || exceptions === undefined) return null;

  const occurrencesForDay = (day: string) => expandForDay([...events, ...subscribed], exceptions, day);
  const [next, ...rest] = nextUpcomingOccurrences(occurrencesForDay, now, 4);
  const nextMetaText = next ? nextMeta(now, next) : null;
  const nextTimeline = next ? formatNextTimeline(now, next.dayKey, next.item) : null;

  return (
    <OverviewBlock section="kalender">
      {next ? (
        <div className="events-overview__next">
          <OverviewCardHead title="Nächster Termin" href="/kalender" moreLabel="Kalender" />
          <div className="events-overview__next-row">
            {!next.item.allDay && (
              <p
                className="events-overview__next-time"
                style={{ '--cat-color': categoryEdgeVar(next.item.category) } as CSSProperties}
              >
                {formatEventTime(next.item.startsAt as string)}
              </p>
            )}
            <div className="events-overview__next-body">
              <p className="events-overview__next-title">{next.item.title}</p>
              {nextMetaText && <p className="events-overview__next-meta">{nextMetaText}</p>}
              {nextTimeline && <p className="events-overview__next-range">{nextTimeline}</p>}
            </div>
          </div>
        </div>
      ) : (
        <div className="events-overview__empty">
          <OverviewCardHead title="Nächster Termin" href="/kalender" moreLabel="Kalender" />
          <p>Keine Termine geplant</p>
        </div>
      )}
      {rest.length > 0 && (
        <ul className="events-overview__rest">
          {rest.map((occurrence) => (
            <li key={occurrence.item.id} className="events-overview__rest-item">
              <span className="events-overview__rest-time">
                {formatRestRowTime(now, occurrence.dayKey, occurrence.item)}
              </span>
              <span className="events-overview__rest-title">{occurrence.item.title}</span>
            </li>
          ))}
        </ul>
      )}
    </OverviewBlock>
  );
}
