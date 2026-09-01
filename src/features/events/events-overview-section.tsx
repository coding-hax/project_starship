'use client';

import type { CSSProperties } from 'react';
import { OverviewBlock, OverviewCardHead } from '@/ui/overview-block';
import { useBlockReady } from '@/ui/overview-ready';
import { useNow } from '@/ui/use-now';
import { categoryEdgeVar, formatCountdown, upcomingEventsToday, type UpcomingEvent } from './event-time';
import { EVENT_CATEGORIES, useEvents } from './use-events';

const timeFormatter = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatTime(instant: string): string {
  return timeFormatter.format(new Date(instant));
}

/** "in 40 Min · Arbeit", or just the countdown without a category (issue #974, AK2). */
function nextSubline(now: Date, next: UpcomingEvent): string {
  const countdown = formatCountdown(now, next.startsAt);
  const categoryLabel = EVENT_CATEGORIES.find((c) => c.value === next.category)?.label;
  return categoryLabel ? `${countdown} · ${categoryLabel}` : countdown;
}

/**
 * Overview section wrapper (issue #308) for "Nächster Termin" (issue #559, S8 von
 * #473, Owner-Entscheidung 6): the next event today rendered large with a
 * countdown, the rest of the day underneath as thin rows. `useNow` re-renders the
 * countdown every tick, so it stays current without a reload.
 *
 * The loading `null` swallows this section's own `<h2>` too, so its arrival moved
 * every section below it — `useBlockReady` ties it into the overview's single
 * reveal point instead (issue #642).
 *
 * Card head "Nächster Termin" → "Kalender" (issue #972, AK2/AK4): rendered
 * inside both the next-event card and the empty state, so a visible title
 * stands in the card head whether or not there is a next event today.
 *
 * Row layout (issue #974, T3 von #971): the start time carries the row, large
 * and in the event's category colour, instead of a leading countdown line and a
 * trailing time-range line — the countdown moves into a single muted meta line
 * next to the title, alongside the category.
 */
export function EventsOverviewSection() {
  const events = useEvents();
  const now = useNow();

  useBlockReady(events !== undefined);

  if (events === undefined) return null;

  const [next, ...rest] = upcomingEventsToday(events, now);

  return (
    <OverviewBlock>
      {next ? (
        <div className="events-overview__next">
          <OverviewCardHead title="Nächster Termin" href="/kalender" moreLabel="Kalender" />
          <div className="events-overview__next-row">
            <p
              className="events-overview__next-time"
              style={{ '--cat-color': categoryEdgeVar(next.category) } as CSSProperties}
            >
              {formatTime(next.startsAt)}
            </p>
            <div className="events-overview__next-body">
              <p className="events-overview__next-title">{next.title}</p>
              <p className="events-overview__next-meta">{nextSubline(now, next)}</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="events-overview__empty">
          <OverviewCardHead title="Nächster Termin" href="/kalender" moreLabel="Kalender" />
          <p>Keine weiteren Termine heute</p>
        </div>
      )}
      {rest.length > 0 && (
        <ul className="events-overview__rest">
          {rest.map((event) => (
            <li key={event.id} className="events-overview__rest-item">
              <span className="events-overview__rest-time">{formatTime(event.startsAt)}</span>
              <span className="events-overview__rest-title">{event.title}</span>
            </li>
          ))}
        </ul>
      )}
    </OverviewBlock>
  );
}
