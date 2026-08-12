/**
 * Überlebt die Navigation von `/uebersicht` nach `/aufgaben` bzw. `/kalender`
 * (issue #618, um den `event`-Fall erweitert in #619) — bewusst In-Memory, kein
 * `sessionStorage`: ein Store, der einen Reload überlebt, wirft Tage später einen
 * alten Draft ins Sheet. `consumeCaptureDraft` leert beim Lesen, damit ein
 * Zurück-Navigieren oder ein erneuter Mount nichts wiederholt.
 *
 * Form `{ items: CaptureDraft[] }` von Anfang an, auch mit genau einem Element —
 * S1 von #617, damit spätere Schnitte (Mehrfach-Erfassung) hier refactorbar bleiben.
 */

export interface TaskCaptureDraftItem {
  kind: 'task';
  title: string;
  dueAt: string | null;
  /** #688: geratene Nachtzeit oder regionale Kurzform — erzwingt das Bestätigungs-Sheet
   * in quick-add.tsx, auch wenn "ohne Bestätigung direkt anlegen" an ist. */
  needsConfirmation: boolean;
}

export interface EventCaptureDraftItem {
  kind: 'event';
  title: string;
  allDay: boolean;
  startsAt: string | null;
  endsAt: string | null;
  startDate: string | null;
  endDate: string | null;
}

export type CaptureDraftItem = TaskCaptureDraftItem | EventCaptureDraftItem;

export interface CaptureDraftBatch {
  items: CaptureDraftItem[];
}

let pending: CaptureDraftBatch | null = null;

export function setCaptureDraft(batch: CaptureDraftBatch): void {
  pending = batch;
}

export function consumeCaptureDraft(): CaptureDraftBatch | null {
  const batch = pending;
  pending = null;
  return batch;
}
