import type { FieldConfidence } from '@/features/capture/types';

export interface FieldHintProps {
  id?: string;
  /** Ein oder mehrere Felder, die sich denselben Eingabe-Control teilen (z. B. Datum +
   * Uhrzeit in einem `datetime-local`-Feld) — jeder geratene Grund erscheint. */
  confidences: FieldConfidence[];
}

/**
 * Warnfarbene Notiz für ein geratenes Feld (issue #691 AK2/AK5) — kein Fehler, eine
 * Vermutung: `--color-warning`, kein Icon, keine Bewegung (AK5/AK6). `null`, solange
 * kein übergebenes Feld `guessed` ist, damit der Aufrufer nicht selbst filtern muss.
 */
export function FieldHint({ id, confidences }: FieldHintProps) {
  const reasons = confidences
    .filter((confidence) => confidence.level === 'guessed' && confidence.reason)
    .map((confidence) => confidence.reason);

  if (reasons.length === 0) return null;

  return (
    <p id={id} className="field-hint">
      {reasons.join(' · ')}
    </p>
  );
}
