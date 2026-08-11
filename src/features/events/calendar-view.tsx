'use client';

import { useState, useSyncExternalStore } from 'react';
import { berlinNow } from '@/push/schedule';
import { Fab } from '@/ui/fab';
import { Toast } from '@/ui/toast';
import { CalendarStrip } from './calendar-strip';
import { EventAgenda } from './event-agenda';
import { EventEditor, type EventEditorState } from './event-editor';
import type { Occurrence } from './recurrence';
import { useDeleteEvent } from './use-delete-event';
import { useEventExceptions } from './use-event-exceptions';
import { useEvents } from './use-events';

const CREATE_LABEL = 'Termin erfassen';

function subscribeNever() {
  return () => {};
}

function getTodayKey() {
  return berlinNow(new Date()).dateKey;
}

function getServerTodayKey(): string | null {
  return null;
}

/**
 * `/kalender` (issue #553/#554/#556, S2+S3+S5 of #473; agenda issue #597): a
 * day agenda behind a week strip that pulls open into the full month, plus
 * the FAB-driven
 * create/edit/delete editor. `selectedDay` is a Berlin calendar day, not the
 * device's local one — the same reference `berlinNow` already gives the
 * reminder scheduler (src/push/schedule.ts), so there is only ever one
 * "today" in this app.
 *
 * `today` is `null` during SSR and the very first client render (issue #579):
 * `berlinNow` reads the client clock, which at that point differs from the
 * Node process's clock (and, in Playwright, from the faked browser clock) —
 * computing it directly in the render body produced a hydration mismatch. The
 * same fix as `JournalHeaderDate` (`useSyncExternalStore` with a `null`
 * server snapshot) fills it in only once the client has taken over.
 * `selectedDay` falls back to `today` until the user picks a day of their
 * own, so it is `null` under the exact same condition. The date-dependent
 * subtree (strip + agenda) only renders once both are known, which also
 * keeps `EventAgenda`'s `useNow`-driven upcoming-item focus off the server
 * render entirely.
 */
export function CalendarView() {
  const events = useEvents();
  const exceptions = useEventExceptions();
  const today = useSyncExternalStore(subscribeNever, getTodayKey, getServerTodayKey);
  const [selectedDayOverride, setSelectedDayOverride] = useState<string | null>(null);
  const selectedDay = selectedDayOverride ?? today;
  const [expanded, setExpanded] = useState(false);
  const [editorState, setEditorState] = useState<EventEditorState>(null);
  const { deleteEvent, undo, handleUndo, dismissUndo } = useDeleteEvent();

  function openCreate() {
    setEditorState({ mode: 'create', event: null, occurrence: null });
  }

  /**
   * `occurrence.eventId` is the anchor `events` row for both a plain event and
   * a series instance — the "nur dieser"/"alle folgenden" scope routing that
   * tells the two apart lives in the editor's submit path (S6), keyed off
   * `occurrence.originalDate` (set only for a series instance). The editor
   * seeds its time fields from `occurrence` itself, not the anchor row — a
   * later occurrence already reads differently (its own exception override,
   * or simply a later date at the anchor's own time-of-day).
   */
  function openEdit(occurrence: Occurrence) {
    const event = events?.find((candidate) => candidate.id === occurrence.eventId);
    if (event) {
      setEditorState({
        mode: 'edit',
        event,
        occurrence: {
          originalDate: occurrence.originalDate ?? null,
          startsAt: occurrence.startsAt,
          endsAt: occurrence.endsAt,
          startDate: occurrence.startDate,
          endDate: occurrence.endDate,
        },
      });
    }
  }

  return (
    <div className="calendar-view">
      {/* <header> is the auto-focus target after navigation (CODEMAP invariant,
          same reasoning as weather-day.tsx) — CalendarStrip's paging controls
          live in it, not just a bare heading. */}
      <header className="calendar-view__header">
        <h1 className="calendar-view__heading">Kalender</h1>
        {today !== null && selectedDay !== null && (
          <CalendarStrip
            selectedDay={selectedDay}
            onSelectDay={setSelectedDayOverride}
            today={today}
            events={events ?? []}
            exceptions={exceptions ?? []}
            expanded={expanded}
            onExpandChange={setExpanded}
          />
        )}
        {today !== null && selectedDay !== null && (
          <div className="calendar-view__today-chip-slot">
            {selectedDay !== today && (
              <button
                type="button"
                className="calendar-view__today-chip"
                onClick={() => setSelectedDayOverride(today)}
              >
                Heute
              </button>
            )}
          </div>
        )}
      </header>
      {today !== null && selectedDay !== null && (
        <EventAgenda
          events={events ?? []}
          exceptions={exceptions ?? []}
          selectedDay={selectedDay}
          today={today}
          onEditEvent={openEdit}
        />
      )}
      <Fab label={CREATE_LABEL} onClick={openCreate} />
      {today !== null && selectedDay !== null && (
        <EventEditor
          state={editorState}
          selectedDay={selectedDay}
          exceptions={exceptions ?? []}
          onClose={() => setEditorState(null)}
          onDelete={deleteEvent}
        />
      )}
      {undo && (
        <Toast
          message={`„${undo.title}" gelöscht`}
          actionLabel="Rückgängig"
          onAction={handleUndo}
          onDismiss={dismissUndo}
        />
      )}
    </div>
  );
}
