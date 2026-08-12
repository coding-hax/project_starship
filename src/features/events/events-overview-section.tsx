'use client';

import { OverviewBlock } from '@/ui/overview-block';
import { useBlockReady } from '@/ui/overview-ready';
import { useNow } from '@/ui/use-now';
import { categoryEdgeVar, formatCountdown, upcomingEventsToday } from './event-time';
import { useEvents } from './use-events';

const timeFormatter = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatTime(instant: string): string {
  return timeFormatter.format(new Date(instant));
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
 */
export function EventsOverviewSection() {
  const events = useEvents();
  const now = useNow();

  useBlockReady(events !== undefined);

  if (events === undefined) return null;

  const [next, ...rest] = upcomingEventsToday(events, now);

  return (
    <OverviewBlock title="Termine" area="var(--area-events)">
      {next ? (
        <div
          className="events-overview__next"
          style={{ borderInlineStartColor: categoryEdgeVar(next.category) }}
        >
          <p className="events-overview__next-countdown">{formatCountdown(now, next.startsAt)}</p>
          <p className="events-overview__next-title">{next.title}</p>
          <p className="events-overview__next-time">
            {formatTime(next.startsAt)}–{formatTime(next.endsAt)}
          </p>
        </div>
      ) : (
        <p className="events-overview__empty">Keine weiteren Termine heute</p>
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
