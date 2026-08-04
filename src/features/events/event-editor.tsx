'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { mutate } from '@/local/outbox';
import { Row } from '@/ui/row';
import { Sheet } from '@/ui/sheet';
import { Toggle } from '@/ui/toggle';
import type { EventData } from '@/local/types';
import {
  cancelOccurrence,
  moveOccurrence,
  splitSeries,
  truncateSeriesFrom,
  type EventFields,
} from './event-mutations';
import { RecurrenceScopeSheet, type RecurrenceScope } from './recurrence-scope-sheet';
import { anchorDateKeyOf } from './recurrence';
import type { EventExceptionView } from './use-event-exceptions';
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

type RecurrenceFreq = NonNullable<EventData['recurrence']>['freq'];

/** Sentinel for "wiederholt sich nicht" — a real `freq` value can never equal this. */
const NO_RECURRENCE = '';

const FREQUENCIES: { value: RecurrenceFreq; label: string }[] = [
  { value: 'daily', label: 'Täglich' },
  { value: 'weekly', label: 'Wöchentlich' },
  { value: 'monthly', label: 'Monatlich' },
  { value: 'yearly', label: 'Jährlich' },
];

/** 0 = Mo … 6 = So, same convention as `recurrence.ts`/`event-time.ts`. */
const WEEKDAYS: { value: number; label: string }[] = [
  { value: 0, label: 'Mo' },
  { value: 1, label: 'Di' },
  { value: 2, label: 'Mi' },
  { value: 3, label: 'Do' },
  { value: 4, label: 'Fr' },
  { value: 5, label: 'Sa' },
  { value: 6, label: 'So' },
];

type RecurrenceEndMode = 'never' | 'until' | 'count';

function recurrenceEqual(a: EventData['recurrence'], b: EventData['recurrence']): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

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

/** The tapped occurrence's own displayed time (recurrence.ts's `Occurrence`,
 *  an exception's override — if any — already applied) — what the time
 *  fields seed from, since a later occurrence of a series can already read
 *  differently than the anchor `events` row itself. `originalDate` is the
 *  Berlin day of that occurrence: `null` for a plain event, always set for a
 *  series instance (even its first one), which is what triggers the "nur
 *  dieser"/"alle folgenden"/"ganze Serie" scope choice below (S6 of #473). */
export interface EditedOccurrence {
  originalDate: string | null;
  startsAt: string | null;
  endsAt: string | null;
  startDate: string | null;
  endDate: string | null;
}

export type EventEditorState =
  | { mode: 'create'; event: null; occurrence: null }
  | { mode: 'edit'; event: EventView; occurrence: EditedOccurrence }
  | null;

/** Pending edit/delete waiting on a scope choice (S6) — captures its own
 *  snapshot of `event` so it survives the parent closing the editor sheet. */
type ScopeAction =
  | {
      kind: 'edit';
      event: EventView;
      originalDate: string;
      fields: EventFields;
      /** The form's current recurrence pattern and whether it differs from the
       *  anchor's own — passed on to `splitSeries` as-is when it does (a freshly
       *  typed count/until starts fresh from here, event-mutations.ts doc
       *  comment), and to "Ganze Serie" the same way as title/category. */
      nextRecurrence: EventData['recurrence'];
      recurrenceChanged: boolean;
      /** Only offered when nothing but the time model changed — `event_exceptions`
       *  cannot override title/category (event-mutations.ts doc comment). */
      offerThis: boolean;
      /** Hidden when the *time* changed on an occurrence other than the series'
       *  own first one: applying that occurrence's new absolute date/time to the
       *  anchor row directly would silently re-anchor the whole series onto that
       *  date, not shift every occurrence by the same amount. "Alle folgenden"
       *  (always offered) is the safe way to apply a time change from here. */
      offerSeries: boolean;
      /** Whether the time model changed at all — when `offerSeries` is true and
       *  this is too, the edited occurrence is the series' own first one, so its
       *  absolute new values are safe to write straight onto the anchor row. */
      timeChanged: boolean;
    }
  | { kind: 'delete'; event: EventView; originalDate: string };

export interface EventEditorProps {
  /** `null` closes the sheet. */
  state: EventEditorState;
  /** Berlin calendar day the timeline is currently showing — the default day
   *  for a new event. */
  selectedDay: string;
  /** Needed to reuse an already-synced exception's own id when "nur dieser"
   *  targets an occurrence a second time (S6, same pattern as
   *  `useToggleHabitLog`). */
  exceptions: EventExceptionView[];
  onClose: () => void;
  /** Only ever called in `edit` mode, for a plain event or the "ganze Serie"
   *  scope choice. Closing the sheet is the caller's job (calendar-view.tsx),
   *  so the undo toast it triggers is not raced by the sheet's own close
   *  transition. */
  onDelete: (event: EventView) => void;
}

/**
 * Bottom-sheet editor for both creating and editing an event (issue #554, S3
 * of #473) — same shell as `task-editor.tsx`/`quick-add.tsx`. `allDay` picks
 * which of the two time models (S1) the form edits; the two never mix on one
 * row (AC5), so both pairs of inputs are kept in separate state and only the
 * active pair is read on submit.
 */
export function EventEditor({
  state,
  selectedDay,
  exceptions,
  onClose,
  onDelete,
}: EventEditorProps) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<string>(NO_CATEGORY);
  const [allDay, setAllDay] = useState(false);
  const [startsAtInput, setStartsAtInput] = useState('');
  const [endsAtInput, setEndsAtInput] = useState('');
  const [startDateInput, setStartDateInput] = useState('');
  const [endDateInput, setEndDateInput] = useState('');
  const [freq, setFreq] = useState<RecurrenceFreq | typeof NO_RECURRENCE>(NO_RECURRENCE);
  const [intervalInput, setIntervalInput] = useState('1');
  const [byWeekday, setByWeekday] = useState<number[]>([]);
  const [endMode, setEndMode] = useState<RecurrenceEndMode>('never');
  const [untilInput, setUntilInput] = useState('');
  const [countInput, setCountInput] = useState('1');
  const titleRef = useRef<HTMLInputElement>(null);
  const wasOpenRef = useRef(false);
  const [scopeAction, setScopeAction] = useState<ScopeAction | null>(null);

  const open = state !== null;
  const mode = state?.mode ?? 'create';
  const event = state?.event ?? null;
  const occurrence = state?.mode === 'edit' ? state.occurrence : null;
  const originalDate = occurrence?.originalDate ?? null;
  const label = mode === 'edit' ? 'Termin bearbeiten' : 'Termin erfassen';

  // Seed exactly once, on the closed->open transition (task-editor.tsx pattern)
  // — not on every re-render, or another device's sync landing mid-edit would
  // overwrite whatever the user is mid-typing here. Time fields seed from the
  // tapped occurrence (`occurrence`), not the anchor `event` itself — a later
  // occurrence of a series can already read differently (its own exception
  // override, or simply a later date at the anchor's own time-of-day).
  useEffect(() => {
    if (open && !wasOpenRef.current && mode === 'edit' && event && occurrence) {
      setTitle(event.title);
      setCategory(event.category ?? NO_CATEGORY);
      setAllDay(event.allDay);
      setStartsAtInput(isoToLocalInput(occurrence.startsAt));
      setEndsAtInput(isoToLocalInput(occurrence.endsAt));
      setStartDateInput(occurrence.startDate ?? '');
      setEndDateInput(occurrence.endDate ?? '');
      const recurrence = event.recurrence;
      setFreq(recurrence?.freq ?? NO_RECURRENCE);
      setIntervalInput(String(recurrence?.interval ?? 1));
      setByWeekday(recurrence?.byWeekday ?? []);
      setEndMode(recurrence?.until ? 'until' : recurrence?.count ? 'count' : 'never');
      setUntilInput(recurrence?.until ?? '');
      setCountInput(recurrence?.count ? String(recurrence.count) : '1');
    }
    if (open && !wasOpenRef.current && mode === 'create') {
      setTitle('');
      setCategory(NO_CATEGORY);
      setAllDay(false);
      setStartsAtInput(`${selectedDay}T09:00`);
      setEndsAtInput(`${selectedDay}T10:00`);
      setStartDateInput(selectedDay);
      setEndDateInput(selectedDay);
      setFreq(NO_RECURRENCE);
      setIntervalInput('1');
      setByWeekday([]);
      setEndMode('never');
      setUntilInput('');
      setCountInput('1');
    }
    wasOpenRef.current = open;
  }, [open, mode, event, occurrence, selectedDay]);

  function toggleWeekday(day: number) {
    setByWeekday((prev) =>
      prev.includes(day) ? prev.filter((candidate) => candidate !== day) : [...prev, day].sort(),
    );
  }

  function buildRecurrence(): EventData['recurrence'] {
    if (!freq) return null;
    const recurrence: NonNullable<EventData['recurrence']> = {
      freq,
      interval: Math.max(1, Number(intervalInput) || 1),
    };
    if (freq === 'weekly' && byWeekday.length > 0) recurrence.byWeekday = byWeekday;
    if (endMode === 'until' && untilInput) recurrence.until = untilInput;
    if (endMode === 'count' && Number(countInput) > 0) recurrence.count = Number(countInput);
    return recurrence;
  }

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

    const nextRecurrence = buildRecurrence();

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
          recurrence: nextRecurrence,
        },
      });
      return;
    }

    if (!occurrence) return; // narrows for TS — `mode === 'edit'` always pairs with one

    const titleChanged = trimmedTitle !== event.title;
    const categoryChanged = nextCategory !== event.category;
    const recurrenceChanged = !recurrenceEqual(nextRecurrence, event.recurrence);
    // Diffed against what the form actually displayed (the tapped occurrence's
    // own values, not necessarily the anchor row's) — a later occurrence can
    // already read differently than the anchor even with zero edits.
    const occurrenceTimeChanged =
      allDay !== event.allDay ||
      nextStartsAt !== occurrence.startsAt ||
      nextEndsAt !== occurrence.endsAt ||
      nextStartDate !== occurrence.startDate ||
      nextEndDate !== occurrence.endDate;

    if (!titleChanged && !categoryChanged && !recurrenceChanged && !occurrenceTimeChanged) {
      onClose();
      return;
    }

    // Editing one occurrence of a recurring series (`originalDate` is set for
    // every series instance, even its first) needs a scope choice before
    // anything is written.
    if (event.recurrence && originalDate) {
      const isAnchorOccurrence = originalDate === anchorDateKeyOf(event);
      onClose();
      setScopeAction({
        kind: 'edit',
        event,
        originalDate,
        fields: {
          title: trimmedTitle,
          allDay,
          startsAt: nextStartsAt,
          endsAt: nextEndsAt,
          startDate: nextStartDate,
          endDate: nextEndDate,
          category: nextCategory as EventData['category'],
        },
        nextRecurrence,
        recurrenceChanged,
        offerThis: occurrenceTimeChanged && !titleChanged && !categoryChanged && !recurrenceChanged,
        offerSeries: isAnchorOccurrence || !occurrenceTimeChanged,
        timeChanged: occurrenceTimeChanged,
      });
      return;
    }

    // Plain (non-recurring) event — the anchor row is what's displayed, so
    // this diff and `occurrenceTimeChanged` agree (ADR-0001 §3: only changed
    // fields go into the mutation, except the time model, which is always
    // written as one consistent set so a row can never end up with both
    // `startsAt` and `startDate` set, AC5).
    const payload: Record<string, unknown> = {};
    if (titleChanged) payload.title = trimmedTitle;
    if (categoryChanged) payload.category = nextCategory;
    if (recurrenceChanged) payload.recurrence = nextRecurrence;
    if (occurrenceTimeChanged) {
      payload.allDay = allDay;
      payload.startsAt = nextStartsAt;
      payload.endsAt = nextEndsAt;
      payload.startDate = nextStartDate;
      payload.endDate = nextEndDate;
    }

    onClose();
    await mutate({ table: 'events', rowId: event.id, op: 'upsert', payload });
  }

  function handleDelete() {
    if (!event) return;

    if (event.recurrence && originalDate) {
      onClose();
      setScopeAction({ kind: 'delete', event, originalDate });
      return;
    }

    onClose();
    onDelete(event);
  }

  async function handleScopeChoice(scope: RecurrenceScope) {
    const action = scopeAction;
    if (!action) return;
    setScopeAction(null);

    if (action.kind === 'edit') {
      const {
        event: target,
        originalDate: date,
        fields,
        nextRecurrence,
        recurrenceChanged,
        timeChanged,
      } = action;
      if (scope === 'this') {
        const override = fields.allDay
          ? { startDate: fields.startDate as string, endDate: fields.endDate as string }
          : { startsAt: fields.startsAt as string, endsAt: fields.endsAt as string };
        await moveOccurrence(target.id, date, exceptions, override);
      } else if (scope === 'following') {
        await splitSeries(
          target,
          date,
          fields,
          recurrenceChanged ? (nextRecurrence ?? undefined) : undefined,
        );
      } else {
        // Reachable with `timeChanged` only when the edited occurrence was the
        // series' own first one (`offerSeries`) — `fields`'s time values are
        // then exactly what the anchor row should read.
        const seriesPayload: Record<string, unknown> = {};
        if (fields.title !== target.title) seriesPayload.title = fields.title;
        if (fields.category !== target.category) seriesPayload.category = fields.category;
        if (recurrenceChanged) seriesPayload.recurrence = nextRecurrence;
        if (timeChanged) {
          seriesPayload.allDay = fields.allDay;
          seriesPayload.startsAt = fields.startsAt;
          seriesPayload.endsAt = fields.endsAt;
          seriesPayload.startDate = fields.startDate;
          seriesPayload.endDate = fields.endDate;
        }
        await mutate({ table: 'events', rowId: target.id, op: 'upsert', payload: seriesPayload });
      }
      return;
    }

    const { event: target, originalDate: date } = action;
    if (scope === 'this') {
      await cancelOccurrence(target.id, date, exceptions);
    } else if (scope === 'following') {
      await truncateSeriesFrom(target, date);
    } else {
      onDelete(target);
    }
  }

  return (
    <>
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
          <label className="event-editor__field">
            <span>Wiederholung</span>
            <select
              className="event-editor__recurrence-freq"
              value={freq}
              onChange={(formEvent) =>
                setFreq(formEvent.target.value as RecurrenceFreq | typeof NO_RECURRENCE)
              }
              aria-label="Wiederholung"
            >
              <option value={NO_RECURRENCE}>Nie</option>
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          {freq && (
            <>
              <label className="event-editor__field">
                <span>Intervall</span>
                <input
                  type="number"
                  min={1}
                  className="event-editor__recurrence-interval"
                  value={intervalInput}
                  onChange={(formEvent) => setIntervalInput(formEvent.target.value)}
                  aria-label="Intervall"
                />
              </label>
              {freq === 'weekly' && (
                <fieldset className="event-editor__weekdays">
                  <legend>Wochentage</legend>
                  {WEEKDAYS.map((day) => (
                    <label key={day.value} className="event-editor__weekday-option">
                      <input
                        type="checkbox"
                        checked={byWeekday.includes(day.value)}
                        onChange={() => toggleWeekday(day.value)}
                      />
                      {day.label}
                    </label>
                  ))}
                </fieldset>
              )}
              <fieldset className="event-editor__recurrence-end">
                <legend>Ende</legend>
                <label className="event-editor__recurrence-end-option">
                  <input
                    type="radio"
                    name="recurrence-end"
                    checked={endMode === 'never'}
                    onChange={() => setEndMode('never')}
                  />
                  Nie
                </label>
                <label className="event-editor__recurrence-end-option">
                  <input
                    type="radio"
                    name="recurrence-end"
                    checked={endMode === 'until'}
                    onChange={() => setEndMode('until')}
                  />
                  Am
                  <input
                    type="date"
                    value={untilInput}
                    onChange={(formEvent) => {
                      setUntilInput(formEvent.target.value);
                      setEndMode('until');
                    }}
                    aria-label="Endet am"
                  />
                </label>
                <label className="event-editor__recurrence-end-option">
                  <input
                    type="radio"
                    name="recurrence-end"
                    checked={endMode === 'count'}
                    onChange={() => setEndMode('count')}
                  />
                  Nach
                  <input
                    type="number"
                    min={1}
                    value={countInput}
                    onChange={(formEvent) => {
                      setCountInput(formEvent.target.value);
                      setEndMode('count');
                    }}
                    aria-label="Anzahl Wiederholungen"
                  />
                  ×
                </label>
              </fieldset>
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
      <RecurrenceScopeSheet
        question={
          scopeAction
            ? scopeAction.kind === 'delete'
              ? 'Termin löschen — für welche Vorkommen?'
              : 'Änderung übernehmen für'
            : null
        }
        options={[
          ...(scopeAction?.kind === 'delete' || scopeAction?.offerThis
            ? [{ scope: 'this' as const, label: 'Nur dieser' }]
            : []),
          { scope: 'following' as const, label: 'Alle folgenden' },
          ...(scopeAction?.kind === 'delete' || scopeAction?.offerSeries
            ? [
                {
                  scope: 'series' as const,
                  label: scopeAction?.kind === 'delete' ? 'Ganze Serie' : 'Ganze Serie ändern',
                },
              ]
            : []),
        ]}
        onChoose={handleScopeChoice}
        onClose={() => setScopeAction(null)}
      />
    </>
  );
}
