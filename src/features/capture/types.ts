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

export type CaptureConfidence = 'high' | 'low';

export interface CaptureDraft {
  kind: CaptureKind;
  title: string;
  /** ISO — Fälligkeit (task) oder absolute Startzeit (event); null sonst. */
  dueAt: string | null;
  /** nur bei `kind: 'habit_check'` gesetzt, sonst null. */
  habitId: string | null;
  confidence: CaptureConfidence;
}

export type Recognizer = (text: string, ctx: CaptureContext) => { items: CaptureDraft[] };
