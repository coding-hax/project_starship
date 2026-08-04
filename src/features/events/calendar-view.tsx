'use client';

import { useState } from 'react';
import { berlinNow } from '@/push/schedule';
import { Fab } from '@/ui/fab';
import { Toast } from '@/ui/toast';
import { EventEditor, type EventEditorState } from './event-editor';
import { EventTimeline } from './event-timeline';
import type { Occurrence } from './recurrence';
import { useDeleteEvent } from './use-delete-event';
import { useEventExceptions } from './use-event-exceptions';
import { useEvents } from './use-events';
import { WeekStrip } from './week-strip';

const CREATE_LABEL = 'Termin erfassen';

/**
 * `/kalender` (issue #553/#554, S2+S3 of #473): a day timeline behind a
 * collapsed week strip, plus the FAB-driven create/edit/delete editor.
 * `selectedDay` is a Berlin calendar day, not the device's local one — the
 * same reference `berlinNow` already gives the reminder scheduler
 * (src/push/schedule.ts), so there is only ever one "today" in this app.
 */
export function CalendarView() {
  const events = useEvents();
  const exceptions = useEventExceptions();
  const today = berlinNow(new Date()).dateKey;
  const [selectedDay, setSelectedDay] = useState(today);
  const [editorState, setEditorState] = useState<EventEditorState>(null);
  const { deleteEvent, undo, handleUndo, dismissUndo } = useDeleteEvent();

  function openCreate() {
    setEditorState({ mode: 'create', event: null });
  }

  /**
   * `occurrence.eventId` is the anchor `events` row for both a plain event and
   * a series instance — the "nur dieser"/"alle folgenden" scope routing that
   * tells the two apart lives in the editor's submit path (S6), not here.
   */
  function openEdit(occurrence: Occurrence) {
    const event = events?.find((candidate) => candidate.id === occurrence.eventId);
    if (event) setEditorState({ mode: 'edit', event });
  }

  return (
    <div className="calendar-view">
      {/* <header> is the auto-focus target after navigation (CODEMAP invariant,
          same reasoning as weather-day.tsx) — WeekStrip's paging controls live
          in it, not just a bare heading. */}
      <header className="calendar-view__header">
        <h1>Kalender</h1>
        <WeekStrip selectedDay={selectedDay} onSelectDay={setSelectedDay} today={today} />
      </header>
      <EventTimeline
        events={events ?? []}
        exceptions={exceptions ?? []}
        selectedDay={selectedDay}
        today={today}
        onEditEvent={openEdit}
      />
      <Fab label={CREATE_LABEL} onClick={openCreate} />
      <EventEditor
        state={editorState}
        selectedDay={selectedDay}
        onClose={() => setEditorState(null)}
        onDelete={deleteEvent}
      />
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
