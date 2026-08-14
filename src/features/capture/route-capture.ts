import { toDateKey } from '../habits/due-today';
import { logicalDayStart } from '../tasks/parse-task-input';
import type { EventCaptureDraftItem, TaskCaptureDraftItem } from '../tasks/capture-draft-store';
import { recognizeLocally } from './local-recognizer';
import type { CaptureContext, CaptureDraft, CaptureKind } from './types';

const ONE_HOUR_MS = 60 * 60 * 1000;

const KIND_MODULE_ID: Record<CaptureKind, string> = {
  task: 'aufgaben',
  event: 'kalender',
  habit_check: 'routinen',
};

/**
 * Welche `CaptureKind`s der Aufruf anbieten darf, aus dem Modul-Ein/Aus-Zustand
 * (`use-modules.ts`) — Journal taucht hier nie auf, weil `CaptureKind` es gar
 * nicht kennt (CLAUDE.md Regel 9).
 */
export function allowedCaptureKinds(isActive: (id: string) => boolean): CaptureKind[] {
  return (Object.keys(KIND_MODULE_ID) as CaptureKind[]).filter((kind) => isActive(KIND_MODULE_ID[kind]));
}

/**
 * Läuft nur den Recognizer (#621), ohne irgendetwas zu entscheiden — die reaktive
 * Grundlage für den Art-Chip (issue #715 AK1): `draft.kind` ist direkt die
 * anzuzeigende Art, bei jedem Tastendruck neu berechenbar, ohne Navigation oder
 * Mutation auszulösen.
 */
export function previewDraft(text: string, ctx: CaptureContext): CaptureDraft {
  return recognizeLocally(text, ctx).items[0];
}

/**
 * `draft` -> Aufgaben-Kernfelder. Kind-unabhängig von `draft.kind` aufrufbar,
 * damit eine von Hand auf "Aufgabe" umgeschaltete Art (issue #715 AK1) trotzdem
 * die erkannte Fälligkeit übernimmt, auch wenn der Recognizer selbst `event`
 * klassifiziert hatte.
 */
export function taskFieldsFromDraft(draft: CaptureDraft): TaskCaptureDraftItem {
  return {
    kind: 'task',
    title: draft.title,
    dueAt: draft.dueAt,
    needsConfirmation: draft.needsConfirmation,
    titleConfidence: draft.confidence.title,
    dateConfidence: draft.confidence.date,
    timeConfidence: draft.confidence.time,
  };
}

/**
 * `draft` -> Termin-Kernfelder, kind-unabhängig wie `taskFieldsFromDraft` oben.
 * Unter dem aktuellen Klassifikator (local-recognizer.ts) bedeutet ein gesetztes
 * `dueAt` immer eine explizite Uhrzeit; ohne `dueAt` (reines Vokabular, z. B.
 * "Meeting mit Chef") gibt es weder Datum noch Uhrzeit — das ist der
 * ganztägig-Fall, vorbefüllt auf den heutigen Tag (R6/#689: der logische, nicht
 * der reale Kalendertag).
 */
export function eventFieldsFromDraft(draft: CaptureDraft, now: Date): EventCaptureDraftItem {
  const confidence = {
    titleConfidence: draft.confidence.title,
    dateConfidence: draft.confidence.date,
    timeConfidence: draft.confidence.time,
  };
  if (draft.dueAt) {
    const endsAt = new Date(new Date(draft.dueAt).getTime() + ONE_HOUR_MS).toISOString();
    return {
      kind: 'event',
      title: draft.title,
      allDay: false,
      startsAt: draft.dueAt,
      endsAt,
      startDate: null,
      endDate: null,
      ...confidence,
    };
  }
  const today = toDateKey(logicalDayStart(now));
  return {
    kind: 'event',
    title: draft.title,
    allDay: true,
    startsAt: null,
    endsAt: null,
    startDate: today,
    endDate: today,
    ...confidence,
  };
}

/**
 * Fallback-Startzeit fürs Zeit-Kernfeld (issue #715 AK4), wenn weder der
 * Erkenner noch der Nutzer eine Uhrzeit gesetzt haben — ein Termin braucht sie
 * trotzdem ("Bis" leitet sich erst daraus per `eventFieldsFromDraft` ab).
 * Gleicher Default wie `event-editor.tsx`s eigener Create-Modus: 09:00 des
 * logischen Heute-Tags (R6/#689).
 */
export function defaultEventStart(now: Date): string {
  return `${toDateKey(logicalDayStart(now))}T09:00`;
}

export interface HabitCheckFields {
  /** Nur bei eindeutigem Treffer gesetzt (`resolved`) — sonst `null`, der Fall
   * "Keiner Gewohnheit zugeordnet" (issue #715 AK5), den der Routine-Kern-Chip
   * dann sichtbar macht statt ihn still zu übergehen. */
  habitId: string | null;
  logDate: string;
  /** `true` nur bei hoher Konfidenz und genau einem Treffer (`matchHabit`) —
   * kein Treffer, ein mehrdeutiger oder ein bloß schwacher zählen alle als
   * nicht aufgelöst. */
  resolved: boolean;
}

/**
 * `draft` -> Routine-Kernfelder, kind-unabhängig wie `taskFieldsFromDraft`/
 * `eventFieldsFromDraft` oben.
 */
export function habitFieldsFromDraft(draft: CaptureDraft, now: Date): HabitCheckFields {
  const resolved = draft.confidence.habit.level === 'high' && draft.habitId !== null;
  return {
    habitId: resolved ? draft.habitId : null,
    // `draft.logDate` ist nur gesetzt, wenn der Recognizer selbst schon auf
    // `habit_check` klassifiziert hat (local-recognizer.ts) — bei einer von
    // Hand überschriebenen Art gibt es kein erkanntes Datum mehr zu lesen,
    // der Log-Tag fällt dann auf den logischen Heute-Tag zurück.
    logDate: draft.logDate ?? toDateKey(logicalDayStart(now)),
    resolved,
  };
}
