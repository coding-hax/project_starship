'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { consumeCaptureDraft } from '@/features/tasks/capture-draft-store';
import { berlinNow } from '@/push/schedule';
import { Fab } from '@/ui/fab';
import { PageFace } from '@/ui/faces';
import { OfflineNotice } from '@/ui/offline-notice';
import { SegmentedControl } from '@/ui/segmented-control';
import { useOnline } from '@/ui/use-online';
import { CalendarStrip } from './calendar-strip';
import { EventAgenda } from './event-agenda';
import { EventDetail, type EventDetailState } from './event-detail';
import { EventEditor, type EventEditorState } from './event-editor';
import { formatMonthTitle, monthEventCounts, monthName, yearLabel } from './event-time';
import { expandForDay, type Occurrence } from './recurrence';
import { useDeleteEvent } from './use-delete-event';
import { useEventExceptions, type EventExceptionView } from './use-event-exceptions';
import { useEvents } from './use-events';
import { useIcsSubscriptionsRefresh, useSubscribedEvents } from './use-ics-subscriptions';

const CREATE_LABEL = 'Termin erfassen';

/** Steht vor der Hydration statt der Augenbraue/des Titels (`leadDay` kennt
 *  „heute" noch nicht, siehe `today`) — ein wirklich leeres Element hätte
 *  Höhe 0 und der Kopf spränge beim Hydration-Flip (gleiches Muster wie
 *  `TodayLongDate`/`GreetingHeading`). */
const NBSP = ' ';

type StripView = 'woche' | 'monat';

const VIEW_OPTIONS: { value: StripView; label: string }[] = [
  { value: 'woche', label: 'Woche' },
  { value: 'monat', label: 'Monat' },
];

/** Stabile Leer-Array-Identität für `exceptions ?? EMPTY_EXCEPTIONS` — sonst
 *  bekäme `CalendarStrip`s `dotsByDay`-Memo bei jedem `calendar-view`-Render
 *  ein neues Array und würde alle 731 gepufferten Tage neu berechnen, seit
 *  `leadDay` (issue #898) das Hochrollen dorthin überträgt. */
const EMPTY_EXCEPTIONS: EventExceptionView[] = [];

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
 * same fix as `TodayLongDate` (`useSyncExternalStore` with a `null`
 * server snapshot) fills it in only once the client has taken over.
 * `selectedDay` falls back to `today` until the user picks a day of their
 * own, so it is `null` under the exact same condition. The date-dependent
 * subtree (strip + agenda) only renders once both are known, which also
 * keeps `EventAgenda`'s `useNow`-driven upcoming-item focus off the server
 * render entirely.
 */
export function CalendarView() {
  const events = useEvents();
  const subscribedEvents = useSubscribedEvents();
  useIcsSubscriptionsRefresh();
  const exceptions = useEventExceptions();
  const online = useOnline();
  const today = useSyncExternalStore(subscribeNever, getTodayKey, getServerTodayKey);
  const [selectedDayOverride, setSelectedDayOverride] = useState<string | null>(null);
  const selectedDay = selectedDayOverride ?? today;
  /** Die führende Zelle/Zeile des Streifens (issue #898) — treibt Augenbraue +
   *  Titel. Aus `CalendarStrip` hochgemeldet über `onLeadDayChange`; fällt bis
   *  zum ersten Bericht auf `today` zurück, gleiches Muster wie `selectedDay`. */
  const [leadDayOverride, setLeadDayOverride] = useState<string | null>(null);
  const leadDay = leadDayOverride ?? today;
  const [expanded, setExpanded] = useState(false);
  const [editorState, setEditorState] = useState<EventEditorState>(null);
  const [detailState, setDetailState] = useState<EventDetailState>(null);
  const { deleteEvent } = useDeleteEvent();

  // Konsumiert einen `event`-Draft, den der Capture-Router auf /uebersicht
  // erkannt hat (issue #619) — genau einmal pro Mount, gleiches Muster wie
  // quick-add.tsx's Task-Pendant: `queueMicrotask` schiebt `setEditorState`
  // hinter einen echten Tick, statt synchron im Effekt-Body selbst Zustand zu
  // setzen. Läuft unabhängig von `today`/`selectedDay` (`EventEditor` selbst
  // rendert erst, sobald beide bekannt sind).
  useEffect(() => {
    const batch = consumeCaptureDraft();
    const item = batch?.items[0];
    if (item?.kind === 'event') {
      queueMicrotask(() =>
        setEditorState({
          mode: 'create',
          event: null,
          occurrence: null,
          prefill: {
            title: item.title,
            allDay: item.allDay,
            startsAt: item.startsAt,
            endsAt: item.endsAt,
            startDate: item.startDate,
            endDate: item.endDate,
            titleConfidence: item.titleConfidence,
            dateConfidence: item.dateConfidence,
            timeConfidence: item.timeConfidence,
          },
        }),
      );
    }
  }, []);

  // Merged only for display (CalendarStrip/EventAgenda) — `openEdit` below keeps
  // looking up `events` alone, so a subscribed item can never resolve to an
  // editable anchor row (ADR-0022 AK2, deep enforcement beyond the read-only
  // rendering in event-agenda.tsx). Memoised (issue #898): `leadDay` now
  // re-renders this component on every crossed cell/row boundary while
  // rolling the strip, and a fresh array identity here would thrash
  // `CalendarStrip`'s own `dotsByDay` memo on each of those re-renders.
  const timelineEvents = useMemo(
    () => [...(events ?? []), ...subscribedEvents],
    [events, subscribedEvents],
  );
  const eventExceptions = exceptions ?? EMPTY_EXCEPTIONS;

  const focusMonth = leadDay === null ? null : leadDay.slice(0, 7);
  const period = leadDay === null ? NBSP : expanded ? yearLabel(leadDay) : formatMonthTitle(leadDay);
  const title = leadDay === null ? NBSP : expanded ? monthName(leadDay) : 'Diese Woche';

  // Nur im Monat berechnet (#834, „nur was die Daten hergeben") — die Woche
  // zeigt den Streifen selbst als Zusatz, keine Chips.
  const counts = useMemo(() => {
    if (!expanded || focusMonth === null) return null;
    return monthEventCounts(focusMonth, (day) => expandForDay(timelineEvents, eventExceptions, day));
  }, [expanded, focusMonth, timelineEvents, eventExceptions]);

  function openCreate() {
    setEditorState({ mode: 'create', event: null, occurrence: null });
  }

  /**
   * Opens the read-only detail sheet on a card tap (issue #806) — the same
   * anchor-row lookup as `openEdit` below, so a subscribed occurrence can
   * never resolve here either (ADR-0022 AK2). `onEdit` on the detail sheet
   * hands the same occurrence to `openEdit` once the anchor row is already
   * known to exist.
   */
  function openDetail(occurrence: Occurrence) {
    const event = events?.find((candidate) => candidate.id === occurrence.eventId);
    if (event) {
      setDetailState({ event, occurrence });
    }
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
        <div className="calendar-view__eyebrow">
          <p className="calendar-view__period page-head__eyebrow">{period}</p>
          <SegmentedControl
            options={VIEW_OPTIONS}
            value={expanded ? 'monat' : 'woche'}
            onChange={(next) => setExpanded(next === 'monat')}
            label="Ansicht"
            variant="ground"
          />
        </div>
        <div className="calendar-view__title-row">
          <h1 className="calendar-view__heading">{title}</h1>
          <PageFace face="kalender" />
        </div>
        {counts !== null && (
          <div className="page-head__extra">
            <div className="page-head__chips">
              <span className="page-head__chip">
                {counts.total} {counts.total === 1 ? 'Termin' : 'Termine'}
              </span>
              <span className="page-head__chip">{counts.allDay} ganztägig</span>
            </div>
          </div>
        )}
        {today !== null && selectedDay !== null && (
          <CalendarStrip
            selectedDay={selectedDay}
            onSelectDay={setSelectedDayOverride}
            today={today}
            events={timelineEvents}
            exceptions={eventExceptions}
            expanded={expanded}
            onLeadDayChange={setLeadDayOverride}
          />
        )}
      </header>
      {!online && (
        <OfflineNotice>
          Offline — neue Termine liegen lokal und werden synchronisiert, sobald du wieder online
          bist.
        </OfflineNotice>
      )}
      {today !== null && selectedDay !== null && (
        <EventAgenda
          events={timelineEvents}
          exceptions={eventExceptions}
          selectedDay={selectedDay}
          today={today}
          onOpenEvent={openDetail}
        />
      )}
      <Fab label={CREATE_LABEL} onClick={openCreate} />
      {today !== null && selectedDay !== null && (
        <EventEditor
          state={editorState}
          selectedDay={selectedDay}
          exceptions={eventExceptions}
          onClose={() => setEditorState(null)}
          onDelete={deleteEvent}
        />
      )}
      <EventDetail
        state={detailState}
        onClose={() => setDetailState(null)}
        onEdit={() => {
          const occurrence = detailState?.occurrence;
          setDetailState(null);
          if (occurrence) openEdit(occurrence);
        }}
      />
    </div>
  );
}
