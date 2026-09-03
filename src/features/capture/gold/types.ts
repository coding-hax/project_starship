import type { CaptureKind } from '../types';

/**
 * Goldkorpus (#erfasser-korpus): Satz + Sollergebnis, unabhängig von der Implementierung.
 *
 * Zwei Schichten, bewusst getrennt:
 * - `kuratiert` — echte Sätze, Sollwert von Hand gesetzt und vom Menschen bestätigt.
 *   Das ist die Wahrheit. Wo Grammatik und Korpus streiten, gewinnt diese Schicht.
 * - `generiert` — Satzmuster × Slot-Werte. Der Sollwert steht per Konstruktion fest
 *   (der Titel IST der eingesetzte Slot-Wert, das Datum kommt aus einer eigenen
 *   Referenz-Auflösung, nie aus dem Parser). Deckt die Kombinatorik ab.
 */
export type GoldSource = 'kuratiert' | 'generiert';

export interface GoldExpectation {
  kind: CaptureKind;
  /** Wortgetreu, ohne Datums-/Zeitausdruck, ohne Kommandopräfix und dessen Funktionswörter. */
  title: string;
  /** ISO-String oder null. Bei `habit_check` immer null (der Log-Tag ist `logDate`). */
  dueAt: string | null;
  habitId?: string | null;
  logDate?: string | null;
}

export interface GoldCase {
  /** Stabil über Läufe: `kur:0007` bzw. `gen:<muster>:<lfd>`. */
  id: string;
  text: string;
  source: GoldSource;
  /** Grobe Rubrik für den Bericht — „Datum relativ", „Zeigerzeit", „Routine abhaken", … */
  category: string;
  /** Bezugspunkt; Default `NOW_REF`. */
  now?: Date;
  habits?: { id: string; name: string }[];
  expect: GoldExpectation;
}

/** Montag, 15.01.2024, 10:00 lokal — derselbe Bezugspunkt wie `corpus.ts`. */
export const NOW_REF = new Date(2024, 0, 15, 10, 0, 0);

/** Fälligkeit ohne gesagte Uhrzeit. Konvention des Bestandsparsers, hier festgeschrieben. */
export const DEFAULT_HOUR = 9;

export const GOLD_HABITS = [
  { id: 'h-sport', name: 'Sport' },
  { id: 'h-yoga', name: 'Yoga' },
  { id: 'h-lesen', name: 'Lesen' },
  { id: 'h-meditation', name: 'Meditation' },
];
