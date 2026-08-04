'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { mutate } from '@/local/outbox';
import { Row } from '@/ui/row';
import { Sheet } from '@/ui/sheet';
import { Toggle } from '@/ui/toggle';
import type { EventData } from '@/local/types';
import type { EventView } from './use-events';

const CATEGORIES: { value: NonNullable<EventData['category']>; label: string }[] = [
  { value: 'privat', label: 'Privat' },
  { value: 'arbeit', label: 'Arbeit' },
  { value: 'gesundheit', label: 'Gesundheit' },
  { value: 'sport', label: 'Sport' },
  { value: 'familie', label: 'Familie' },
];

/** Sentinel for "keine Kategorie" — a real category value can never equal this. */
const NO_CATEGORY = '';

/** `datetime-local` works in the browser's local time, with no timezone suffix. */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localInputToIso(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

export type EventEditorState = { mode: 'create' | 'edit'; event: EventView | null } | null;

export interface EventEditorProps {
  /** `null` closes the sheet. */
  state: EventEditorState;
  /** Berlin calendar day the timeline is currently showing — the default day
   *  for a new event. */
  selectedDay: string;
  onClose: () => void;
  /** Only ever called in `edit` mode. Closing the sheet is the caller's job
   *  (calendar-view.tsx), so the undo toast it triggers is not raced by the
   *  sheet's own close transition. */
  onDelete: (event: EventView) => void;
}

/**
 * Bottom-sheet editor for both creating and editing an event (issue #554, S3
 * of #473) — same shell as `task-editor.tsx`/`quick-add.tsx`. `allDay` picks
 * which of the two time models (S1) the form edits; the two never mix on one
 * row (AC5), so both pairs of inputs are kept in separate state and only the
 * active pair is read on submit.
 */
export function EventEditor({ state, selectedDay, onClose, onDelete }: EventEditorProps) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<string>(NO_CATEGORY);
  const [allDay, setAllDay] = useState(false);
  const [startsAtInput, setStartsAtInput] = useState('');
  const [endsAtInput, setEndsAtInput] = useState('');
  const [startDateInput, setStartDateInput] = useState('');
  const [endDateInput, setEndDateInput] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);

  const open = state !== null;
  const mode = state?.mode ?? 'create';
  const event = state?.event ?? null;
  const label = mode === 'edit' ? 'Termin bearbeiten' : 'Termin erfassen';

  // Seed exactly once, on the closed->open transition (task-editor.tsx pattern)
  // — not on every re-render, or another device's sync landing mid-edit would
  // overwrite whatever the user is mid-typing here.
  useEffect(() => {
    if (open && !wasOpenRef.current && mode === 'edit' && event) {
      setTitle(event.title);
      setCategory(event.category ?? NO_CATEGORY);
      setAllDay(event.allDay);
      setStartsAtInput(isoToLocalInput(event.startsAt));
      setEndsAtInput(isoToLocalInput(event.endsAt));
      setStartDateInput(event.startDate ?? '');
      setEndDateInput(event.endDate ?? '');
    }
    if (open && !wasOpenRef.current && mode === 'create') {
      setTitle('');
      setCategory(NO_CATEGORY);
      setAllDay(false);
      setStartsAtInput(`${selectedDay}T09:00`);
      setEndsAtInput(`${selectedDay}T10:00`);
      setStartDateInput(selectedDay);
      setEndDateInput(selectedDay);
    }
    wasOpenRef.current = open;
  }, [open, mode, event, selectedDay]);

  async function handleSubmit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();

    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      titleRef.current?.focus();
      return;
    }

    const nextCategory = category || null;
    const nextStartsAt = allDay ? null : localInputToIso(startsAtInput);
    const nextEndsAt = allDay ? null : localInputToIso(endsAtInput);
    const nextStartDate = allDay ? startDateInput || null : null;
    const nextEndDate = allDay ? endDateInput || null : null;

    if (mode === 'create' || !event) {
      onClose();
      await mutate({
        table: 'events',
        op: 'upsert',
        payload: {
          title: trimmedTitle,
          allDay,
          startsAt: nextStartsAt,
          endsAt: nextEndsAt,
          startDate: nextStartDate,
          endDate: nextEndDate,
          category: nextCategory,
        },
      });
      return;
    }

    // Edit: only the fields that actually changed go into the mutation (ADR-0001
    // §3), except the time model — that is always written as one consistent set
    // when anything about it changes, so a row can never end up with both
    // `startsAt` and `startDate` set (AC5).
    const payload: Record<string, unknown> = {};
    if (trimmedTitle !== event.title) payload.title = trimmedTitle;
    if (nextCategory !== event.category) payload.category = nextCategory;

    const timeModelChanged =
      allDay !== event.allDay ||
      nextStartsAt !== event.startsAt ||
      nextEndsAt !== event.endsAt ||
      nextStartDate !== event.startDate ||
      nextEndDate !== event.endDate;

    if (timeModelChanged) {
      payload.allDay = allDay;
      payload.startsAt = nextStartsAt;
      payload.endsAt = nextEndsAt;
      payload.startDate = nextStartDate;
      payload.endDate = nextEndDate;
    }

    onClose();
    if (Object.keys(payload).length > 0) {
      await mutate({ table: 'events', rowId: event.id, op: 'upsert', payload });
    }
  }

  function handleDelete() {
    if (!event) return;
    onClose();
    onDelete(event);
  }

  return (
    <Sheet open={open} onClose={onClose} label={label} initialFocusRef={titleRef}>
      <form className="event-editor" onSubmit={handleSubmit}>
        <input
          ref={titleRef}
          type="text"
          className="event-editor__title"
          value={title}
          onChange={(formEvent) => setTitle(formEvent.target.value)}
          aria-label="Titel"
        />
        <label className="event-editor__field">
          <span>Kategorie</span>
          <select
            className="event-editor__category"
            value={category}
            onChange={(formEvent) => setCategory(formEvent.target.value)}
            aria-label="Kategorie"
          >
            <option value={NO_CATEGORY}>Keine</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <Row label="Ganztägig">
          <Toggle checked={allDay} onChange={setAllDay} label="Ganztägig" />
        </Row>
        {allDay ? (
          <>
            <label className="event-editor__field">
              <span>Von</span>
              <input
                type="date"
                className="event-editor__start"
                value={startDateInput}
                onChange={(formEvent) => setStartDateInput(formEvent.target.value)}
                aria-label="Von"
                required
              />
            </label>
            <label className="event-editor__field">
              <span>Bis</span>
              <input
                type="date"
                className="event-editor__end"
                value={endDateInput}
                onChange={(formEvent) => setEndDateInput(formEvent.target.value)}
                aria-label="Bis"
                required
              />
            </label>
          </>
        ) : (
          <>
            <label className="event-editor__field">
              <span>Von</span>
              <input
                type="datetime-local"
                className="event-editor__start"
                value={startsAtInput}
                onChange={(formEvent) => setStartsAtInput(formEvent.target.value)}
                aria-label="Von"
                required
              />
            </label>
            <label className="event-editor__field">
              <span>Bis</span>
              <input
                type="datetime-local"
                className="event-editor__end"
                value={endsAtInput}
                onChange={(formEvent) => setEndsAtInput(formEvent.target.value)}
                aria-label="Bis"
                required
              />
            </label>
          </>
        )}
        <div className="event-editor__actions">
          {mode === 'edit' && (
            <button type="button" className="event-editor__delete" onClick={handleDelete}>
              Löschen
            </button>
          )}
          <button type="submit" className="event-editor__submit">
            Speichern
          </button>
        </div>
      </form>
    </Sheet>
  );
}
