'use client';

import { useMemo } from 'react';
import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { useListPresence } from '@/ui/use-list-presence';
import { useNow } from '@/ui/use-now';
import { allDayEventsForDay, categoryEdgeVar, layoutForDay, nowLinePct } from './event-time';
import { expandForDay, type Occurrence } from './recurrence';
import type { EventExceptionView } from './use-event-exceptions';
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
  /** `event_exceptions` rows — applied to their targeted occurrence only (S6 of #473). */
  exceptions: EventExceptionView[];
  selectedDay: string;
  /** Today's Berlin date key — the now-line only ever shows on today's own timeline. */
  today: string;
  /** Opens the editor on a card tap (issue #554). Hands up the full occurrence
   *  (not just an id) so the caller can tell a series instance apart from a
   *  plain event and build the "nur dieser"/"alle folgenden" scope (S6).
   *  Optional — S1/S2 tests that only check visibility render this component
   *  without it. */
  onEditEvent?: (occurrence: Occurrence) => void;
}

/**
 * Day timeline: all-day band, 0–24h hour axis, now-line, scheduled event cards
 * (issue #553; all-day band issue #555, S4; recurring series issue #557, S6).
 */
export function EventTimeline({ events, exceptions, selectedDay, today, onEditEvent }: EventTimelineProps) {
  const now = useNow();
  const occurrences = useMemo(
    () => expandForDay(events, exceptions, selectedDay),
    [events, exceptions, selectedDay],
  );
  const cards = useMemo(() => layoutForDay(occurrences, selectedDay), [occurrences, selectedDay]);
  const cardRows = useListPresence(cards, (card) => card.id);
  const allDayItems = useMemo(
    () => allDayEventsForDay(occurrences, selectedDay),
    [occurrences, selectedDay],
  );
  const allDayRows = useListPresence(allDayItems, (item) => item.id);
  const showNowLine = selectedDay === today;

  return (
    <div className="event-timeline">
      {allDayItems.length > 0 && (
        <div className="event-timeline__all-day">
          <span className="event-timeline__all-day-spacer" aria-hidden="true" />
          <ul className="event-timeline__all-day-list">
            {allDayRows.map(({ key, item, status, onAnimationEnd }) => (
              <li
                key={key}
                className="event-timeline__all-day-item list-motion-item"
                data-entering={status === 'entering'}
                data-leaving={status === 'leaving'}
                onAnimationEnd={onAnimationEnd}
              >
                <button
                  type="button"
                  className="event-timeline__all-day-button"
                  data-continues-before={item.continuesBefore}
                  data-continues-after={item.continuesAfter}
                  style={{ borderInlineStartColor: categoryEdgeVar(item.category) }}
                  onClick={() => onEditEvent?.(item)}
                >
                  {item.continuesBefore && (
                    <IconChevronLeft className="event-timeline__all-day-chevron" />
                  )}
                  <span className="event-timeline__all-day-title">{item.title}</span>
                  {item.continuesAfter && (
                    <IconChevronRight className="event-timeline__all-day-chevron" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="event-timeline__body">
        <ul className="event-timeline__hours" aria-hidden="true">
          {HOURS.map((hour) => (
            <li key={hour} className="event-timeline__hour">
              <span className="event-timeline__hour-label">{String(hour).padStart(2, '0')}:00</span>
            </li>
          ))}
        </ul>
        <div className="event-timeline__track">
          {showNowLine && (
            <div className="event-timeline__now-line" style={{ top: `${nowLinePct(now)}%` }} />
          )}
          <ul className="event-timeline__cards">
            {cardRows.map(({ key, item: card, status, onAnimationEnd }) => (
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
                <button
                  type="button"
                  className="event-timeline__card-button"
                  onClick={() => onEditEvent?.(card)}
                >
                  <span className="event-timeline__card-title">{card.title}</span>
                  <span className="event-timeline__card-time">
                    {formatTime(card.startsAt)}–{formatTime(card.endsAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
