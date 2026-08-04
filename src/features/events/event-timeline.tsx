'use client';

import { useListPresence } from '@/ui/use-list-presence';
import { useNow } from '@/ui/use-now';
import { categoryEdgeVar, layoutForDay, nowLinePct } from './event-time';
import type { EventView } from './use-events';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

const timeFormatter = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatTime(instant: string): string {
  return timeFormatter.format(new Date(instant));
}

export interface EventTimelineProps {
  events: EventView[];
  selectedDay: string;
  /** Today's Berlin date key — the now-line only ever shows on today's own timeline. */
  today: string;
}

/**
 * Day timeline: 0–24h hour axis, now-line, scheduled event cards (issue #553).
 * All-day/multi-day events are S4 (#555) — `layoutForDay` already filters them out.
 */
export function EventTimeline({ events, selectedDay, today }: EventTimelineProps) {
  const now = useNow();
  const cards = layoutForDay(events, selectedDay);
  const rows = useListPresence(cards, (card) => card.id);
  const showNowLine = selectedDay === today;

  return (
    <div className="event-timeline">
      <ul className="event-timeline__hours" aria-hidden="true">
        {HOURS.map((hour) => (
          <li key={hour} className="event-timeline__hour">
            <span className="event-timeline__hour-label">{String(hour).padStart(2, '0')}:00</span>
          </li>
        ))}
      </ul>
      <div className="event-timeline__track">
        {showNowLine && (
          <div
            className="event-timeline__now-line"
            data-testid="event-timeline-now-line"
            style={{ top: `${nowLinePct(now)}%` }}
          />
        )}
        <ul className="event-timeline__cards">
          {rows.map(({ key, item: card, status, onAnimationEnd }) => (
            <li
              key={key}
              className="event-timeline__card list-motion-item"
              data-entering={status === 'entering'}
              data-leaving={status === 'leaving'}
              onAnimationEnd={onAnimationEnd}
              style={{
                top: `${card.topPct}%`,
                height: `${card.heightPct}%`,
                borderInlineStartColor: categoryEdgeVar(card.category),
              }}
            >
              <span className="event-timeline__card-title">{card.title}</span>
              <span className="event-timeline__card-time">
                {formatTime(card.startsAt)}–{formatTime(card.endsAt)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
