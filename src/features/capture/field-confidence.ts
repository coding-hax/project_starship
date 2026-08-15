import type { FieldConfidence } from './types';

/**
 * Kleine, geteilte Helfer rund um `FieldConfidence` (#691) — sowohl `local-recognizer.ts`
 * (Erkenner-Pfad) als auch `quick-add.tsx` (Direktpfad über `parseTaskInput`, ohne den
 * Erkenner) bauen daraus ihre `CaptureDraft`/`CaptureConfirmDraft`-Konfidenz, damit der
 * Grundtext „kein Titel erkannt" nur an einer Stelle steht.
 */

export const TITLE_EMPTY_REASON = 'kein Titel erkannt';

export function confidenceFromReason(reason: string | null): FieldConfidence {
  return reason ? { level: 'guessed', reason } : { level: 'high' };
}

export function titleConfidence(title: string): FieldConfidence {
  return confidenceFromReason(title.trim() === '' ? TITLE_EMPTY_REASON : null);
}

/** issue #716 Entscheidung B: Wörter, die für sich allein nie einen Titel tragen —
 * eine Äußerung, die nach Datum/Uhrzeit-Abzug nur noch aus diesen besteht, gilt als
 * reine Attribut-Korrektur, nicht als neuer Titel. */
export const TITLE_FILLER_WORDS = new Set([
  'eher',
  'etwa',
  'circa',
  'ca',
  'gegen',
  'so',
  'halt',
  'eben',
  'mal',
  'noch',
  'dann',
  'ungefähr',
  'vielleicht',
]);

/** issue #716 Entscheidung B: die Schwelle fürs Titel-Überschreiben beim Zusammenführen
 * mehrerer Äußerungen (`mergeDraft`) — nicht leer nach Kantentrim und mindestens ein
 * Inhaltstoken (Länge ≥ 3, nicht in `TITLE_FILLER_WORDS`). Greift nur beim Überschreiben
 * eines schon gesetzten Titels, nicht bei der Erstbelegung (die übernimmt `analyzeText`s
 * Titel unverändert, auch leer). */
export function isSubstantialTitle(title: string): boolean {
  const trimmed = title.trim();
  if (trimmed === '') return false;
  return trimmed
    .split(/\s+/)
    .some((word) => word.length >= 3 && !TITLE_FILLER_WORDS.has(word.toLowerCase()));
}
