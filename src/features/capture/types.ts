/**
 * Die Naht zwischen dem lokalen Erkenner (dieses Ticket, #621) und dem späteren
 * Modell-Erkenner (#620): beide erfüllen `Recognizer`. Der Router (#619) kennt nur
 * diesen Typ, ein Austausch der Implementierung ist kein Umbau.
 */

export type CaptureKind = 'task' | 'event' | 'habit_check';

export interface CaptureContext {
  now: Date;
  tz: string;
  habits: { id: string; name: string }[];
  allowedKinds: CaptureKind[];
}

/** Internes Konfidenzmaß von `matchHabit` (habit-match.ts) — nicht dasselbe wie die
 * Feld-Konfidenz unten, die daraus erst am Rand von `local-recognizer.ts` gebaut wird. */
export type CaptureConfidence = 'high' | 'low';

/**
 * Feld-Konfidenz (#691): ersetzt den alten satzweiten `confidence`-Wert. `guessed`
 * heißt nicht falsch — es heißt, der Erkenner hat eine Annahme getroffen, die eine
 * deterministische Grammatik nie mit Sicherheit auflösen kann. `reason` ist das
 * Satzfragment für den Bestätigen-Dialog (capture-confirm.tsx, event-editor.tsx),
 * gesetzt bei `level: 'guessed'`.
 */
export type FieldConfidenceLevel = 'high' | 'guessed';

export interface FieldConfidence {
  level: FieldConfidenceLevel;
  reason?: string;
}

export type CaptureConfidenceField = 'kind' | 'title' | 'date' | 'time' | 'habit';

export interface CaptureDraft {
  kind: CaptureKind;
  title: string;
  /** ISO — Fälligkeit (task) oder absolute Startzeit (event); null sonst. */
  dueAt: string | null;
  /** nur bei `kind: 'habit_check'` gesetzt, sonst null. */
  habitId: string | null;
  /** `YYYY-MM-DD` — nur bei `kind: 'habit_check'` gesetzt, sonst null. Der Log-Tag
   * (nicht dueAt!), R6/R7 (#689): logischer Heute-Tag, außer der Satz nennt ein Datum
   * bis 7 Tage rückwärts. */
  logDate: string | null;
  /** #688: unverändert seit vor #691 — steuert nur, ob überhaupt ein Bestätigungs-Dialog
   * erscheint (route-capture.ts/quick-add.tsx). Kein Teil der Feld-Konfidenz-Anzeige. */
  needsConfirmation: boolean;
  /** #691: Konfidenz je Feld — steuert, wie ein bereits offener Dialog seine
   * Unsicherheit zeigt (capture-confirm.tsx AK1–AK6, event-editor.tsx AK3). */
  confidence: Record<CaptureConfidenceField, FieldConfidence>;
}

export type Recognizer = (text: string, ctx: CaptureContext) => { items: CaptureDraft[] };
