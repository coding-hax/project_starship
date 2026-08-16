import { toDateKey } from '../habits/due-today';
import { logicalDayStart } from '../tasks/parse-task-input';
import type { EventCaptureDraftItem, TaskCaptureDraftItem } from '../tasks/capture-draft-store';
import { recognizeLocally } from './local-recognizer';
import type { CaptureContext, CaptureDraft, CaptureKind, FieldMentions } from './types';

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

/**
 * Führt den bisherigen Stand (`prev`, `null` vor der ersten Übernahme) mit einer neuen
 * Äußerung zusammen (issue #716, „Vorschau-Merge"). `prev === null` -> die Äußerung
 * zählt unverändert als Erstbelegung (AK1), inklusive ihrer eigenen Art-Klassifikation.
 * Danach bleibt die Art fix (nur der Art-Chip ändert sie, Entscheidung C) — jedes
 * andere Feld übernimmt Wert **und** Konfidenz aus der Äußerung nur, wenn `mentions`
 * es als genannt markiert (AK2/AK4); sonst bleiben Wert und Konfidenz von `prev`
 * unangetastet stehen (AK3).
 */
export function mergeDraft(
  prev: CaptureDraft | null,
  utterance: CaptureDraft,
  mentions: FieldMentions,
): CaptureDraft {
  if (prev === null) return utterance;

  return {
    kind: prev.kind,
    title: mentions.titleSubstantial ? utterance.title : prev.title,
    dueAt: mentions.due ? utterance.dueAt : prev.dueAt,
    habitId: mentions.habit ? utterance.habitId : prev.habitId,
    logDate: mentions.habit ? utterance.logDate : prev.logDate,
    needsConfirmation: mentions.due ? utterance.needsConfirmation : prev.needsConfirmation,
    // #780: die Art wird mit der ersten Übernahme fix (Entscheidung C, oben) — der
    // Leerzustand-Status des Art-Chips zieht mit, sonst würde er nach einer zweiten,
    // ebenso signal-losen Übernahme unerklärlich verschwinden.
    provisional: prev.provisional,
    newHabit: mentions.habit ? utterance.newHabit : prev.newHabit,
    confidence: {
      kind: prev.confidence.kind,
      title: mentions.titleSubstantial ? utterance.confidence.title : prev.confidence.title,
      date: mentions.due ? utterance.confidence.date : prev.confidence.date,
      time: mentions.due ? utterance.confidence.time : prev.confidence.time,
      habit: mentions.habit ? utterance.confidence.habit : prev.confidence.habit,
    },
  };
}

function joinGerman(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}`;
}

/** AK5: ein deutscher Ein-Satz-Text, was eine Übernahme geändert hat — `null`, wenn
 * nichts davon betroffen war (z. B. die erste Übernahme, dort gibt es noch keinen
 * Vorzustand zum Vergleichen). `changed` sind bereits aufgelöste Feldnamen
 * („Titel"/„Fälligkeit"/„Zeit"/„Routine"), die Kind-Abhängigkeit (Fälligkeit vs. Zeit)
 * löst der Aufrufer, der `preview.kind` kennt. */
export function summarizeChanges(changed: string[]): string | null {
  if (changed.length === 0) return null;
  return `${joinGerman(changed)} aktualisiert.`;
}

/** AK6: benennt, welche Kern-Felder ein Artwechsel unsichtbar macht (die Werte selbst
 * bleiben bis zum Schließen des Sheets erhalten — nur die Anzeige verschwindet). */
export function describeDroppedFields(fields: string[]): string | null {
  if (fields.length === 0) return null;
  const verb = fields.length === 1 ? 'entfällt' : 'entfallen';
  return `${joinGerman(fields)} ${verb}.`;
}
