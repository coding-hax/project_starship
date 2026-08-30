'use client';

import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { useListPresence } from '@/ui/use-list-presence';
import { useNow } from '@/ui/use-now';
import {
  agendaForDay,
  allDayEventsForDay,
  allDayRangeLabel,
  categoryEdgeVar,
  formatDuration,
  nextInAgenda,
} from './event-time';
import { expandForDay, type Occurrence } from './recurrence';
import type { EventExceptionView } from './use-event-exceptions';
import { EVENT_CATEGORIES, type EventView } from './use-events';

const timeFormatter = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatTime(instant: string): string {
  return timeFormatter.format(new Date(instant));
}

/** "1 Std 30 Min · Arbeit", or just the duration without a category (issue #923, AK1). */
function agendaSubline(item: { startsAt: string; endsAt: string; category: EventView['category'] }): string {
  const duration = formatDuration(item.startsAt, item.endsAt);
  const categoryLabel = EVENT_CATEGORIES.find((c) => c.value === item.category)?.label;
  return categoryLabel ? `${duration} · ${categoryLabel}` : duration;
}

export interface EventAgendaProps {
  events: EventView[];
  /** `event_exceptions` rows — applied to their targeted occurrence only (S6 of #473). */
  exceptions: EventExceptionView[];
  selectedDay: string;
  /** Today's Berlin date key — decides whether the agenda focuses the next
   *  upcoming item or simply the day's first (issue #597, AK4). */
  today: string;
  /** Opens the read-only detail sheet on a card tap (issue #806 — used to open
   *  the editor directly, issue #554). Hands up the full occurrence (not just
   *  an id) so the caller can tell a series instance apart from a plain event
   *  and build the "nur dieser"/"alle folgenden" scope (S6) once the detail
   *  sheet hands off into `EventEditor`. Optional — S1/S2 tests that only
   *  check visibility render this component without it. */
  onOpenEvent?: (occurrence: Occurrence) => void;
}

/**
 * Day agenda: all-day band, chronological list of scheduled events (issue #597 —
 * replaces the 0–24h hour-axis timeline of #553; all-day band issue #555, S4;
 * recurring series issue #557, S6).
 */
export function EventAgenda({ events, exceptions, selectedDay, today, onOpenEvent }: EventAgendaProps) {
  const now = useNow();
  const listRef = useRef<HTMLUListElement>(null);
  const occurrences = useMemo(
    () => expandForDay(events, exceptions, selectedDay),
    [events, exceptions, selectedDay],
  );
  const items = useMemo(() => agendaForDay(occurrences, selectedDay), [occurrences, selectedDay]);
  // `selectedDay` as the presence reset key (issue #611): paging to another day
  // replaces the list wholesale, so the previous day's entries are dropped on
  // the spot instead of lingering over the new day for their exit animation.
  const itemRows = useListPresence(items, (item) => item.id, selectedDay);
  const allDayItems = useMemo(
    () => allDayEventsForDay(occurrences, selectedDay),
    [occurrences, selectedDay],
  );
  const allDayRows = useListPresence(allDayItems, (item) => item.id, selectedDay);
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
            {allDayRows.map(({ key, item, status, onAnimationEnd }) => {
              // Subscribed items render as a plain `<div>`, never a `<button>` with
              // `onOpenEvent` wired up — the deep enforcement of ADR-0022 AK2
              // (calendar-view.tsx's `openEdit`/`openDetail` only resolving synced
              // `events` is the other half). `data-origin` drives the read-only
              // styling below.
              const isSubscribed = item.origin === 'subscribed';
              const AllDayTag = isSubscribed ? 'div' : 'button';
              return (
                <li
                  key={key}
                  className="event-agenda__all-day-item list-motion-item"
                  data-entering={status === 'entering'}
                  data-leaving={status === 'leaving'}
                  onAnimationEnd={onAnimationEnd}
                >
                  <AllDayTag
                    {...(isSubscribed ? {} : { type: 'button' as const, onClick: () => onOpenEvent?.(item) })}
                    className="event-agenda__all-day-button"
                    data-origin={item.origin}
                    data-continues-before={item.continuesBefore}
                    data-continues-after={item.continuesAfter}
                    style={{ '--agenda-cat': categoryEdgeVar(item.category) } as CSSProperties}
                  >
                    <span className="event-agenda__all-day-dot" aria-hidden="true" />
                    <span className="event-agenda__all-day-title">{item.title}</span>
                    <span className="event-agenda__all-day-range">{allDayRangeLabel(item)}</span>
                  </AllDayTag>
                </li>
              );
            })}
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
            style={{ '--agenda-edge': categoryEdgeVar(item.category) } as CSSProperties}
          >
            <button type="button" className="event-agenda__item-button" onClick={() => onOpenEvent?.(item)}>
              <span className="event-agenda__item-time">{formatTime(item.startsAt)}</span>
              <span className="event-agenda__item-text">
                <span className="event-agenda__item-title">{item.title}</span>
                <span className="event-agenda__item-subline">
                  {agendaSubline(item)}
                  {item.overlaps && <span className="event-agenda__overlap-note"> · Überschneidung</span>}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {items.length === 0 && allDayItems.length === 0 && (
        <p className="event-agenda__empty">Keine Termine an diesem Tag.</p>
      )}
    </div>
  );
}
