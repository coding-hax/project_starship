'use client';

import { Sheet } from '@/ui/sheet';
import { categoryEdgeVar } from './event-time';
import type { Occurrence } from './recurrence';
import { EVENT_CATEGORIES, type EventView } from './use-events';

export type EventDetailState = { event: EventView; occurrence: Occurrence } | null;

export interface EventDetailProps {
  /** `null` closes the sheet. */
  state: EventDetailState;
  onClose: () => void;
  /** Switches to the editor — the caller (calendar-view.tsx) closes this sheet
   *  and opens `EventEditor` in the same step, same hand-off pattern as the
   *  editor's own transition into `RecurrenceScopeSheet`. */
  onEdit: () => void;
}

const TIME_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** All-day fields hold a bare `YYYY-MM-DD` key — formatted at UTC so it reads
 *  as the same calendar day regardless of the device's own offset, same
 *  reasoning as `event-editor.tsx`'s `whenLabel`. */
const WEEKDAY_SHORT_UTC_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short',
  timeZone: 'UTC',
});
const DAY_MONTH_UTC_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'UTC',
});

const RECURRENCE_LABELS: Record<NonNullable<EventView['recurrence']>['freq'], string> = {
  daily: 'Täglich',
  weekly: 'Wöchentlich',
  monthly: 'Monatlich',
  yearly: 'Jährlich',
};

/** `HH:MM–HH:MM` for a timed occurrence — the tapped day is already the page
 *  context, so unlike the editor's own "Wann" chip this deliberately carries
 *  no date. All-day: the single day, or a `–`-joined span (issue #806 AK2). */
function whenLabel(occurrence: Occurrence): string {
  if (occurrence.allDay && occurrence.startDate) {
    const start = new Date(`${occurrence.startDate}T00:00:00Z`);
    if (!occurrence.endDate || occurrence.endDate === occurrence.startDate) {
      return `${WEEKDAY_SHORT_UTC_FORMATTER.format(start)} ${DAY_MONTH_UTC_FORMATTER.format(start)}`;
    }
    const end = new Date(`${occurrence.endDate}T00:00:00Z`);
    return `${DAY_MONTH_UTC_FORMATTER.format(start)}–${DAY_MONTH_UTC_FORMATTER.format(end)}`;
  }
  if (occurrence.startsAt && occurrence.endsAt) {
    return `${TIME_FORMATTER.format(new Date(occurrence.startsAt))}–${TIME_FORMATTER.format(new Date(occurrence.endsAt))}`;
  }
  return '';
}

/**
 * Read-only detail sheet opened by a card tap in the agenda (issue #806) —
 * replaces jumping straight into `EventEditor`, which used to autofocus the
 * title field and pop the keyboard on a mere look. No `header` prop, own
 * buttons instead (same shape as `RecurrenceScopeSheet`): nothing here is a
 * form, and with no input in the subtree `Sheet`'s native `showModal()`
 * autofocus lands on "Bearbeiten" — never the keyboard.
 */
export function EventDetail({ state, onClose, onEdit }: EventDetailProps) {
  const open = state !== null;
  const event = state?.event ?? null;
  const occurrence = state?.occurrence ?? null;

  return (
    <Sheet open={open} onClose={onClose} label={event?.title ?? ''}>
      {event && occurrence && (
        <div className="event-detail">
          <h2 className="event-detail__title">{event.title}</h2>
          <p className="event-detail__when">{whenLabel(occurrence)}</p>
          {event.recurrence && (
            <p className="event-detail__recurrence">{RECURRENCE_LABELS[event.recurrence.freq]}</p>
          )}
          {event.category && (
            <p
              className="event-detail__category"
              style={{ borderInlineStartColor: categoryEdgeVar(event.category) }}
            >
              {EVENT_CATEGORIES.find((c) => c.value === event.category)!.label}
            </p>
          )}
          <div className="event-detail__actions">
            <button type="button" className="event-detail__edit" onClick={onEdit}>
              Bearbeiten
            </button>
            <button type="button" className="event-detail__close" onClick={onClose}>
              Schließen
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}
