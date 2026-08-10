'use client';

import { useEffect, useMemo, useRef } from 'react';
import { IconChevronLeft, IconChevronRight } from '@/ui/icons';
import { useListPresence } from '@/ui/use-list-presence';
import { useNow } from '@/ui/use-now';
import { agendaForDay, allDayEventsForDay, categoryEdgeVar, nextInAgenda } from './event-time';
import { expandForDay, type Occurrence } from './recurrence';
import type { EventExceptionView } from './use-event-exceptions';
import type { EventView } from './use-events';

const timeFormatter = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatTime(instant: string): string {
  return timeFormatter.format(new Date(instant));
}

export interface EventAgendaProps {
  events: EventView[];
  /** `event_exceptions` rows — applied to their targeted occurrence only (S6 of #473). */
  exceptions: EventExceptionView[];
  selectedDay: string;
  /** Today's Berlin date key — decides whether the agenda focuses the next
   *  upcoming item or simply the day's first (issue #597, AK4). */
  today: string;
  /** Opens the editor on a card tap (issue #554). Hands up the full occurrence
   *  (not just an id) so the caller can tell a series instance apart from a
   *  plain event and build the "nur dieser"/"alle folgenden" scope (S6).
   *  Optional — S1/S2 tests that only check visibility render this component
   *  without it. */
  onEditEvent?: (occurrence: Occurrence) => void;
}

/**
 * Day agenda: all-day band, chronological list of scheduled events (issue #597 —
 * replaces the 0–24h hour-axis timeline of #553; all-day band issue #555, S4;
 * recurring series issue #557, S6).
 */
export function EventAgenda({ events, exceptions, selectedDay, today, onEditEvent }: EventAgendaProps) {
  const now = useNow();
  const listRef = useRef<HTMLUListElement>(null);
  const occurrences = useMemo(
    () => expandForDay(events, exceptions, selectedDay),
    [events, exceptions, selectedDay],
  );
  const items = useMemo(() => agendaForDay(occurrences, selectedDay), [occurrences, selectedDay]);
  const itemRows = useListPresence(items, (item) => item.id);
  const allDayItems = useMemo(
    () => allDayEventsForDay(occurrences, selectedDay),
    [occurrences, selectedDay],
  );
  const allDayRows = useListPresence(allDayItems, (item) => item.id);
  const upcoming = nextInAgenda(items, now, selectedDay === today);

  useEffect(() => {
    const target = listRef.current?.querySelector('[data-upcoming="true"]');
    target?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }, [selectedDay]);

  return (
    <div className="event-agenda">
      {allDayItems.length > 0 && (
        <div className="event-agenda__all-day">
          <ul className="event-agenda__all-day-list">
            {allDayRows.map(({ key, item, status, onAnimationEnd }) => (
              <li
                key={key}
                className="event-agenda__all-day-item list-motion-item"
                data-entering={status === 'entering'}
                data-leaving={status === 'leaving'}
                onAnimationEnd={onAnimationEnd}
              >
                <button
                  type="button"
                  className="event-agenda__all-day-button"
                  data-continues-before={item.continuesBefore}
                  data-continues-after={item.continuesAfter}
                  style={{ borderInlineStartColor: categoryEdgeVar(item.category) }}
                  onClick={() => onEditEvent?.(item)}
                >
                  {item.continuesBefore && <IconChevronLeft className="event-agenda__all-day-chevron" />}
                  <span className="event-agenda__all-day-title">{item.title}</span>
                  {item.continuesAfter && <IconChevronRight className="event-agenda__all-day-chevron" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ul className="event-agenda__list" ref={listRef}>
        {itemRows.map(({ key, item, status, onAnimationEnd }) => (
          <li
            key={key}
            className="event-agenda__item list-motion-item"
            data-entering={status === 'entering'}
            data-leaving={status === 'leaving'}
            data-overlap={item.overlaps}
            data-upcoming={item.id === upcoming?.id}
            onAnimationEnd={onAnimationEnd}
            style={{ borderInlineStartColor: categoryEdgeVar(item.category) }}
          >
            <button type="button" className="event-agenda__item-button" onClick={() => onEditEvent?.(item)}>
              <span className="event-agenda__item-time">
                {formatTime(item.startsAt)}–{formatTime(item.endsAt)}
              </span>
              <span className="event-agenda__item-title">{item.title}</span>
              {item.overlaps && <span className="event-agenda__overlap-note">überschneidet sich</span>}
            </button>
          </li>
        ))}
      </ul>
      {items.length > 0 && <p className="event-agenda__sparse">Danach nichts mehr geplant.</p>}
      {items.length === 0 && allDayItems.length === 0 && (
        <p className="event-agenda__empty">Keine Termine an diesem Tag.</p>
      )}
    </div>
  );
}
