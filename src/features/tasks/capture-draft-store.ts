/**
 * Überlebt die Navigation von `/uebersicht` nach `/aufgaben` (issue #618) — bewusst
 * In-Memory, kein `sessionStorage`: ein Store, der einen Reload überlebt, wirft Tage
 * später einen alten Draft ins Sheet. `consumeCaptureDraft` leert beim Lesen, damit
 * ein Zurück-Navigieren oder ein erneuter Mount nichts wiederholt.
 *
 * Form `{ items: CaptureDraft[] }` von Anfang an, auch mit genau einem Element —
 * S1 von #617, damit spätere Schnitte (Mehrfach-Erfassung) hier refactorbar bleiben.
 */

export interface CaptureDraft {
  title: string;
  dueAt: string | null;
}

export interface CaptureDraftBatch {
  items: CaptureDraft[];
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
