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
